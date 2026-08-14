/**
 * dsa-zotero-sidebar host half: the `/zotero/api` JSON route that serves the
 * Zotero library tree to the client half by running the local `zotero-cli`.
 *
 * The client (browser) fetches `/zotero/api/<method>` with a trust-checked
 * request; the host resolves each method against the ZoteroHost and returns
 * the lossless JSON envelope. Cross-plugin collaboration happens over this
 * HTTP route, never by importing host values into the client bundle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ZoteroHost, ZoteroError } from './host/zotero.js'

// Re-export the host for standalone tests / tooling (not part of the plugin surface).
export { ZoteroHost }
import type {
  ZoteroErr,
  ZoteroLibraryTreeResult,
  ZoteroNodeDescriptor,
  ZoteroSearchResponse,
} from './shared.js'
import type { Context, DsaTools } from './context-types.js'

/** The JSON body size bound for one request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** The plugin identity row name (matches package.json `name`). */
export const name = 'dsa-zotero-sidebar'

/** Services required before mounting: the webserver carrier. */
export const inject = ['webServer']

/** Body envelope writers (mirror of the standard plugin wire). */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}
function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true as const, value })
}
function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof ZoteroError) {
    writeJson(res, error.status, { ok: false as const, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false as const, error: { code: 'internal', message } })
}

/** Read and parse the JSON request body (bounded; malformed → zotero bad-request). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new ZoteroError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ZoteroError('bad-request', 'request body is not valid JSON')
  }
}

/** Narrow an unknown payload value to a non-empty string. */
function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '' || value === 'undefined') {
    throw new ZoteroError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

/** Browser-trust fence: only loopback / same-origin browser requests may hit the routes. */
export function isTrusted(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host
  if (hostHeader === undefined) return false
  const hostUrl = new URL(`http://${hostHeader}`)
  const hostname = hostUrl.hostname
  const isLoopback =
    hostname === 'localhost'
    || hostname === '[::1]'
    || (hostname.split('.').length === 4
      && hostname.split('.').every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && Number(part) >= 0))
  if (!isLoopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Plugin body: mount the /zotero/api route. */
export function apply(ctx: Context): void {
  const zotero = new ZoteroHost()

  // The dispatch table: method name -> handler(payload).
  const api: Record<string, (payload: unknown) => Promise<unknown> | unknown> = {
    // Whole-library collection hierarchy (all collection dirs at once).
    'library.tree': async (): Promise<ZoteroLibraryTreeResult> => {
      return zotero.libraryTree()
    },
    // The items of one tree path (leaf descriptors; collections load lazily).
    'node.expand': async (payload): Promise<ZoteroNodeDescriptor[]> => {
      const path = requireString(payload, 'path')
      return zotero.expand(path)
    },
    // Raw collection-items feed for one collection key (future use).
    'collection.items': async (payload): Promise<unknown> => {
      const key = requireString(payload, 'key')
      return zotero.collectionItems(key)
    },
    // Search the library for items matching a query (the & search popup).
    'search': async (payload): Promise<ZoteroSearchResponse> => {
      const query = typeof (payload as { query?: unknown } | null)?.query === 'string'
        ? (payload as { query: string }).query
        : ''
      const limit = typeof (payload as { limit?: unknown } | null)?.limit === 'number'
        ? (payload as { limit: number }).limit
        : 20
      return zotero.search(query, limit)
    },
    // Resolve one item by key (the model's resolve_zotero_ref tool).
    'item.resolve': async (payload): Promise<unknown> => {
      const key = requireString(payload, 'key')
      return zotero.resolveByKey(key)
    },
  }

  // ── Model-facing tool: resolve one Zotero reference into rich details ──
  // Registered against `ctx.tools` when present (optional service). The tool
  // lets the model turn a `[title]{%ZoteroItem:KEY}` reference it sees in the
  // conversation into structured paper info (title, authors, year, abstract,
  // tree path). The definition is a plain ToolDefinition (no `defineTool` value
  // import — the tools service's register accepts the raw object).
  const tools = ctx.get?.('tools') as DsaTools | undefined
  if (tools !== undefined) {
    ctx.effect(() => tools.register({
      name: 'resolve_zotero_ref',
      description: 'Resolve one Zotero reference — a `[title]{%ZoteroItem:KEY}` token inserted by the Zotero sidebar — into the referenced paper\'s rich details: title, type, authors (full list), year, venue, abstract, tags, extra fields (DOI/url/...), library path, and the attached files (e.g. PDFs) with their on-disk absolute paths. When the conversation contains a `{%ZoteroItem:KEY}` token, extract the KEY and call this tool to obtain the paper\'s metadata and its PDF location.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The Zotero item key embedded in the {%ZoteroItem:KEY} reference token.' },
        },
        required: ['key'],
      },
      execute: async (args: unknown): Promise<unknown> => {
        const record = args as { key?: unknown } | null
        const key = typeof record?.key === 'string' ? record.key : ''
        if (key === '') return { ok: false as const, error: 'missing key' }
        const resolved = await zotero.resolveByKey(key)
        if (resolved === null) return { ok: false as const, error: `no Zotero item with key "${key}"` }
        return { ok: true as const, value: resolved }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            value: {
              type: 'object',
              additionalProperties: true,
              properties: {
                key: { type: 'string' },
                title: { type: 'string' },
                typeName: { type: 'string' },
                creatorsLabel: { type: 'string' },
                creators: { type: 'array', items: { type: 'string' } },
                year: { type: 'string' },
                venue: { type: 'string' },
                abstractPreview: { type: 'string' },
                path: { type: 'string' },
                dateAdded: { type: 'string' },
                dateModified: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                fields: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    DOI: { type: 'string' },
                    url: { type: 'string' },
                    pages: { type: 'string' },
                    volume: { type: 'string' },
                    issue: { type: 'string' },
                    publisher: { type: 'string' },
                    place: { type: 'string' },
                    ISBN: { type: 'string' },
                    ISSN: { type: 'string' },
                  },
                },
                attachments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      key: { type: 'string' },
                      filename: { type: 'string' },
                      path: { type: 'string' },
                      linkMode: { type: 'number' },
                      contentType: { type: 'string' },
                      absolutePath: { type: 'string' },
                      isPDF: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => {
          const resolved = (value as { ok: boolean; value?: unknown; error?: string } | null)
          if (resolved === null || resolved.ok !== true) {
            const err = resolved !== null && typeof resolved.error === 'string' ? resolved.error : 'Zotero reference not resolved'
            return [{ type: 'text', text: `Zotero 引用解析失败：${err}` }]
          }
          const v = resolved.value as {
            title?: string; creatorsLabel?: string; year?: string; abstractPreview?: string
            path?: string; venue?: string; tags?: string[]; attachments?: Array<{
              key?: string; filename?: string; absolutePath?: string; contentType?: string; isPDF?: boolean; path?: string
            }>
          }
          const lines = [
            `【Zotero 引用】${v.title ?? ''}`,
            ...(v.creatorsLabel ? [`作者: ${v.creatorsLabel}`] : []),
            ...(v.year ? [`年份: ${v.year}`] : []),
            ...(v.venue ? [`出处: ${v.venue}`] : []),
            ...((v.tags?.length ?? 0) > 0 ? [`标签: ${v.tags!.join(', ')}`] : []),
            ...(v.abstractPreview ? [`摘要: ${v.abstractPreview}${v.abstractPreview.length >= 200 ? '…' : ''}`] : []),
            ...(v.path ? [`位置: ${v.path}`] : []),
            ...(v.attachments && v.attachments.length > 0 ? [
              `附件:`,
              ...v.attachments.map((a) => `  · ${a.filename ?? a.key ?? '(unnamed)'}${a.isPDF ? ' [PDF]' : ''} → ${a.absolutePath ?? a.path ?? '(不在本地，仅存链接)'}`),
            ] : []),
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
    }), 'dsa-zotero-sidebar: resolve_zotero_ref tool')
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/zotero/api',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isTrusted(req)) {
        writeJson(res, 403, { ok: false as const, error: { code: 'forbidden', message: 'forbidden' } } satisfies ZoteroErr)
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false as const, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/zotero/api/') ? pathname.slice('/zotero/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new ZoteroError('bad-request', 'unknown zotero API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new ZoteroError('bad-request', `unknown zotero API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsa-zotero-sidebar: /zotero/api route')
}

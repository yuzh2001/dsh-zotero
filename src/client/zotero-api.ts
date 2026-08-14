/**
 * Typed fetch wrapper over the /zotero JSON API. Every call posts to
 * `/zotero/api/<method>`; the host returns the `{ok, value}` / `{ok, error}`
 * envelope. Failures surface as ZoteroApiError with the wire code.
 */
import type {
  ZoteroErr,
  ZoteroLibraryTreeResult,
  ZoteroNodeDescriptor,
  ZoteroSearchResponse,
} from '../shared.js'

/** One wire failure. */
export class ZoteroApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/zotero/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new ZoteroApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new ZoteroApiError(
      (parsed as ZoteroErr | null)?.error?.code ?? 'http',
      (parsed as ZoteroErr | null)?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/** The client-side Zotero API surface. */
export const zoteroApi = {
  libraryTree: (signal?: AbortSignal) =>
    call<ZoteroLibraryTreeResult>('library.tree', {}, signal),
  expand: (path: string, signal?: AbortSignal) =>
    call<ZoteroNodeDescriptor[]>('node.expand', { path }, signal),
  search: (query: string, limit = 20, signal?: AbortSignal) =>
    call<ZoteroSearchResponse>('search', { query, limit }, signal),
  resolve: (key: string, signal?: AbortSignal) =>
    call<unknown>('item.resolve', { key }, signal),
}

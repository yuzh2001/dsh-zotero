/**
 * The Zotero data source for the dsa-zotero-sidebar host: reads the local
 * `zotero.sqlite` via node:sqlite (`zotero-sqlite.ts`), replacing the earlier
 * approach that spawned the external `zotero-cli` binary.
 *
 * Why the swap
 *   - Faster: no subprocess spawn + double JSON roundtrip per request; the
 *     SQLite reader hits the DB in-process.
 *   - No external binary dependency (zotero-cli is not bundled by default).
 *
 * In-memory model: the first read loads the ENTIRE library once in a single
 * batched query (~70ms) via `ZoteroSqliteReader.loadLibrary()`. Every method
 * here (tree / expand / search / resolve / items) then answers purely from
 * memory — zero further SQLite traffic — until the snapshot is refreshed by
 * the watcher, at which point the model is rebuilt once. Behaviour contract
 * of the /zotero/api route layer in index.ts is unchanged.
 */
import { ZoteroSnapshotCache, ZoteroSnapshotWatcher, zoteroLiveDbPath } from './zotero-sqlite.js'
import type { ZoteroLibrary, ZoteroRow } from './zotero-sqlite.js'
import type {
  ZoteroAttachmentInfo,
  ZoteroCollectionNode,
  ZoteroItem,
  ZoteroItemResolve,
  ZoteroItemSummary,
  ZoteroNodeDescriptor,
  ZoteroSearchResponse,
  ZoteroSearchResult,
} from '../shared.js'
import { basename } from 'node:path'

/** The single top-level virtual node: the whole library (a directory → trailing slash). */
export const ROOT_NAME = 'Zotero 文库/'
export const ROOT_PATH = ROOT_NAME
export const ROOT_KEY = '__root__'

/** Errors a route turns into a clean JSON error envelope. */
export class ZoteroError extends Error {
  constructor(
    readonly code: 'zotero-error' | 'bad-request' | 'not-found',
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

interface RegistryNode {
  kind: 'collection' | 'item'
  key: string
  name: string
  parentPath: string
  collectionKey?: string
  hasChildren: boolean
}

/** Virtual file-tree path registry (same as before; unchanged). */
class PathRegistry {
  private readonly nodes = new Map<string, RegistryNode>()

  private register(parentPath: string, name: string, kind: 'collection' | 'item', key: string, hasChildren: boolean): string {
    for (const [path, node] of this.nodes) {
      if (node.parentPath === parentPath && node.name === name && node.key === key) return path
    }
    const base = parentPath === '' ? name : `${parentPath}${name}`
    let candidate = base
    for (const [path] of this.nodes) {
      if (path === base) {
        const prefix = base.endsWith('/') ? `${base.slice(0, -1)} · ${key}/` : `${base} · ${key}`
        candidate = prefix
        break
      }
    }
    this.nodes.set(candidate, { kind, key, name, parentPath, hasChildren })
    return candidate
  }

  addCollection(parentPath: string, name: string, key: string, hasChildren: boolean): string {
    return this.register(parentPath, `${name}/`, 'collection', key, hasChildren)
  }

  addItem(collectionPath: string, name: string, key: string): string {
    return this.register(collectionPath, name, 'item', key, false)
  }

  addRoot(name: string): string {
    return this.register('', name, 'collection', ROOT_KEY, true)
  }

  get(path: string): RegistryNode | undefined {
    return this.nodes.get(path)
  }

  includesKey(key: string): boolean {
    for (const node of this.nodes.values()) if (node.key === key) return true
    return false
  }

  pathForKey(key: string): string | undefined {
    for (const [path, node] of this.nodes) if (node.key === key) return path
    return undefined
  }
}

/**
 * The Zotero host. One instance per plugin activation; owns the path registry
 * and an in-memory full-library model rebuilt on snapshot change.
 */
export class ZoteroHost {
  private readonly registry = new PathRegistry()
  private readonly cache: ZoteroSnapshotCache
  /** Full in-memory library model; built lazily and rebuilt when the snapshot changes. */
  private library: ZoteroLibrary | null = null
  private libraryStamp = -1

  constructor(cache?: ZoteroSnapshotCache) {
    this.cache = cache ?? ZoteroHost.defaultCache()
  }

  /** Build a watcher-backed cache over the user's live Zotero DB. */
  private static defaultCache(): ZoteroSnapshotCache {
    return new ZoteroSnapshotCache(new ZoteroSnapshotWatcher(zoteroLiveDbPath(), {}).start())
  }

  close(): void { this.cache.close() }

  /**
   * Return an up-to-date in-memory copy of the whole library. Reads the LIVE
   * zotero.sqlite directly in immutable mode (no 95MB copy, bypasses Zotero's
   * rollback-journal lock) via a fresh short-lived connection per read. The
   * live file's mtime is the change stamp: unchanged -> reuse the cached model,
   * changed -> rebuild it fully (~10ms batched load; no diff needed even for
   * tens of thousands of items). Every read method below serves purely from
   * memory, zero SQLite traffic.
   */
  private ensureLibrary(): ZoteroLibrary {
    const stamp = this.cache.snapshotStamp()
    if (this.library === null || stamp !== this.libraryStamp) {
      this.library = this.cache.readLiveImmutable((r) => r.loadLibrary(), this.libraryStamp).value
      this.libraryStamp = stamp
    }
    return this.library
  }

  private tree(): ZoteroCollectionNode[] {
    return this.ensureLibrary().tree
  }

  /** Convert a reader row into the host's ZoteroItem (stable route shape). */
  private toItem(row: ZoteroRow): ZoteroItem {
    const path = row.attachments[0]?.absolutePath ?? null
    return {
      itemID: row.itemID,
      key: row.key,
      libraryID: row.libraryID,
      itemTypeID: 0,
      typeName: row.itemType,
      dateAdded: row.dateAdded ?? '',
      dateModified: row.dateModified ?? '',
      version: 0,
      title: row.fields.title ?? '',
      noteParentItemID: null,
      noteContent: row.isNote ? (row.fields.note ?? null) : null,
      attachmentParentItemID: null,
      annotationParentItemID: null,
      annotationText: null,
      annotationComment: null,
      linkMode: row.attachments[0]?.linkMode ?? null,
      contentType: row.attachments[0]?.contentType ?? null,
      attachmentPath: path,
      fields: row.fields,
      creators: row.creators,
      tags: row.tags,
      isAttachment: row.isAttachment,
      isNote: row.isNote,
      isAnnotation: false,
      parentItemID: null,
      noteText: row.isNote ? (row.fields.note ?? '') : '',
      notePreview: row.isNote ? (row.fields.note ?? '').slice(0, 200) : '',
    }
  }

  /** Whole library tree: root + every collection path. */
  async libraryTree(): Promise<{ rootPath: string; rootName: string; nodes: ZoteroNodeDescriptor[] }> {
    const tree = this.tree()
    if (this.registry.get(ROOT_PATH) === undefined) this.registry.addRoot(ROOT_NAME)
    const nodes: ZoteroNodeDescriptor[] = []
    const collect = (items: ZoteroCollectionNode[], parentPath: string): void => {
      for (const node of items) {
        const children = node.children ?? []
        const path = this.registry.addCollection(parentPath, node.collectionName, node.key, children.length > 0)
        nodes.push({ path, name: node.collectionName, kind: 'collection', key: node.key, hasChildren: children.length > 0 })
        collect(children, path)
      }
    }
    collect(tree, ROOT_PATH)
    return { rootPath: ROOT_PATH, rootName: ROOT_NAME, nodes }
  }

  /** Resolve a collection key to its ordered bibliographic rows from memory. */
  private collectionRows(key: string): ZoteroRow[] {
    const lib = this.ensureLibrary()
    const collID = lib.collectionByKey.get(key)
    if (collID === undefined) return []
    const ids = lib.collectionItems.get(collID) ?? []
    const rows: ZoteroRow[] = []
    for (const id of ids) {
      const row = lib.itemsByID.get(id)
      if (row !== undefined) rows.push(row)
    }
    return rows
  }

  /** The items of one collection path (leaf descriptors, lazy-loaded). */
  async expand(path: string): Promise<ZoteroNodeDescriptor[]> {
    if (path === '') throw new ZoteroError('bad-request', 'path is required')
    let effective = path === ROOT_PATH
      ? { kind: 'collection' as const, key: ROOT_KEY, name: ROOT_NAME }
      : this.registry.get(path)
    if (effective === undefined) {
      await this.libraryTree()
      effective = this.registry.get(path)
    }
    if (effective === undefined) throw new ZoteroError('not-found', `unknown node path "${path}"`, 404)
    if (effective.kind !== 'collection' || effective.key === ROOT_KEY) return []
    const rows = this.collectionRows(effective.key)
    const out: ZoteroNodeDescriptor[] = []
    for (const row of rows) {
      const itemPath = this.registry.addItem(path, displayTitle(row), row.key)
      out.push({ path: itemPath, name: displayTitle(row), kind: row.isAttachment ? 'attachment' : (row.isNote ? 'note' : 'item'), key: row.key, hasChildren: false })
    }
    return out
  }

  /** Raw items feed for a collection key (future external API consumers). */
  async collectionItems(key: string): Promise<ZoteroItem[]> {
    return this.collectionRows(key).map((row) => this.toItem(row))
  }

  /** One item by key (future detail view). */
  async itemDetail(key: string): Promise<ZoteroItem | undefined> {
    const row = this.ensureLibrary().itemsByKey.get(key)
    return row === undefined ? undefined : this.toItem(row)
  }

  /** A summary slice (for search + resolve). */
  itemSummary(item: ZoteroItem): ZoteroItemSummary {
    const fields = (item.fields ?? {}) as Record<string, unknown>
    const creators = (item.creators ?? []) as Array<{ name?: string; lastName?: string; firstName?: string } | string>
    const names = creators.map((c) => {
      if (typeof c === 'string') return c
      return c.name ?? [c.lastName, c.firstName].filter(Boolean).join(', ')
    }).filter(Boolean)
    const abstractNote = typeof fields.abstractNote === 'string' ? fields.abstractNote : undefined
    const date = typeof fields.date === 'string' ? fields.date : undefined
    const year = date?.match(/\d{4}/)?.[0]
    const venue = (typeof fields.conferenceName === 'string' && fields.conferenceName.trim() !== '' && fields.conferenceName)
      || (typeof fields.proceedingsTitle === 'string' && fields.proceedingsTitle.trim() !== '' && fields.proceedingsTitle)
      || (typeof fields.publicationTitle === 'string' && fields.publicationTitle.trim() !== '' && fields.publicationTitle)
      || (typeof fields.bookTitle === 'string' && fields.bookTitle.trim() !== '' && fields.bookTitle)
      || (typeof fields.publisher === 'string' && fields.publisher.trim() !== '' ? fields.publisher : undefined)
    return {
      key: item.key,
      title: item.title || '(untitled)',
      typeName: item.typeName,
      creatorsLabel: names.slice(0, 4).join('; '),
      ...(year !== undefined ? { year } : {}),
      ...(venue !== undefined ? { venue } : {}),
      ...(abstractNote !== undefined && abstractNote.trim() !== ''
        ? { abstractPreview: abstractNote.trim().slice(0, 200) }
        : {}),
    }
  }

  /** Search across the whole library (in-memory LIKE over fields/creators/tags/key). */
  async search(query: string, limit = 20): Promise<ZoteroSearchResponse> {
    const q = query.trim()
    if (q === '') return { query, results: [] }
    const lib = this.ensureLibrary()
    const needle = q.toLowerCase()
    const results: ZoteroSearchResult[] = []
    for (const id of lib.allItemIDs) {
      const row = lib.itemsByID.get(id)
      if (row === undefined) continue
      const hay: string[] = [row.key]
      for (const v of Object.values(row.fields)) hay.push(String(v))
      for (const c of row.creators) hay.push(c.name)
      for (const t of row.tags) hay.push(t)
      if (!hay.some((h) => h.toLowerCase().includes(needle))) continue
      const summary = this.itemSummary(this.toItem(row))
      const path = this.findPathByKey(row.key)
      results.push(path === undefined ? summary : { ...summary, path })
      if (results.length >= limit) break
    }
    return { query: q, results }
  }

  /**
   * Resolve one item's rich detail by key (for the model's resolve tool).
   * Unlike the search/summary slice, this carries the full creator list, tags,
   * timestamps, extra bibliography fields, and — most importantly for the user —
   * the item's attached files (PDFs etc.) with their on-disk locations.
   */
  async resolveByKey(key: string): Promise<ZoteroItemResolve | null> {
    const row = this.ensureLibrary().itemsByKey.get(key)
    if (row === undefined) return null
    const fields = (row.fields ?? {}) as Record<string, string>
    const summary = this.itemSummary(this.toItem(row))
    const path = this.findPathByKey(key)
    const creators = (row.creators ?? []).map((c) => c.name).filter(Boolean) as string[]
    const attachments = this.attachmentInfos(row)
    const dateAdded = row.dateAdded ?? undefined
    const dateModified = row.dateModified ?? undefined
    const knownFieldKeys = [
      'abstractNote', 'date', 'publicationTitle', 'bookTitle', 'proceedingsTitle',
      'conferenceName', 'publisher', 'DOI', 'url', 'ISBN', 'ISSN',
      'journalAbbreviation', 'language', 'place', 'volume', 'issue', 'pages',
      'series', 'edition', 'version', 'archive', 'archiveLocation', 'callNumber',
      'rights', 'accessDate', 'shortTitle', 'title',
    ]
    const extraFields: Record<string, string> = {}
    for (const k of knownFieldKeys) {
      const v = fields[k]
      if (typeof v === 'string' && v.trim() !== '') extraFields[k] = v
    }
    const out: ZoteroItemResolve = {
      ...summary,
      ...(path !== undefined ? { path } : {}),
      ...(dateAdded !== undefined ? { dateAdded } : {}),
      ...(dateModified !== undefined ? { dateModified } : {}),
      tags: row.tags ?? [],
      creators,
      attachments,
      fields: extraFields,
    }
    return out
  }

  /** Build wire-friendly attachment descriptors (with on-disk PDF locations). */
  private attachmentInfos(row: ZoteroRow): ZoteroAttachmentInfo[] {
    return (row.attachments ?? []).map((a) => {
      const filename = a.absolutePath ?? a.path?.replace(/^storage:/, '') ?? null
      const isPDF = a.contentType === 'application/pdf' || /\.pdf$/i.test(filename ?? '')
      return {
        key: a.key,
        filename,
        path: a.path,
        linkMode: a.linkMode,
        contentType: a.contentType,
        absolutePath: a.absolutePath,
        isPDF,
      }
    })
  }

  private findPathByKey(key: string): string | undefined {
    return this.registry.includesKey(key) ? this.registry.pathForKey(key) : undefined
  }
}

/** The display name of an item row for the tree leaf. */
function displayTitle(row: ZoteroRow): string {
  let t = row.fields.title?.trim()
  if (!t) {
    if (row.isAttachment) t = '(attachment)'
    else if (row.isNote) t = '(note)'
    else t = '(untitled)'
  }
  return t
}
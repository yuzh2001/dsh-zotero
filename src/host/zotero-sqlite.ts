/**
 * zotero-sqlite.ts — read the local Zotero library from a SQLite snapshot.
 *
 * The plugin NEVER reads/writes the live `zotero.sqlite` directly. Instead a
 * `ZoteroSnapshotWatcher` (below) keeps an up-to-date, atomically-replaced
 * copy of the library in a stable cache file, and every read goes through
 * `ZoteroSqliteReader` which is pointed at that snapshot. This fully decouples
 * the plugin from Zotero's own database file, so we can never corrupt it.
 *
 * Why atomic replacement matters: copying straight over the live DB while
 * Zotero writes (rollback journal, not WAL) could hand a reader a partial file.
 * The watcher instead copies to a sibling temp file and renames it into place —
 * rename is atomic on POSIX, so a reader always opens a complete snapshot.
 *
 * Zero runtime deps: Node's built-in `node:sqlite` (Node >= 22.5, ideally
 * >= 24). Connections are opened `readOnly` with `PRAGMA query_only` — we
 * never write through SQLite; the only write is the watcher's atomic copy.
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, copyFileSync, mkdtempSync, unlinkSync, renameSync, mkdirSync, statSync, watch, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ZoteroCollectionNode } from '../shared.js'

const DATA_DIR: string = process.env.ZOTERO_DATA_DIR ?? join(homedir(), 'Zotero')
const DB_PATH: string = process.env.ZOTERO_DB ?? join(DATA_DIR, 'zotero.sqlite')

/** Absolute path to the live Zotero database (the file we never touch directly). */
export function zoteroLiveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZOTERO_DB ?? join(env.ZOTERO_DATA_DIR ?? join(homedir(), 'Zotero'), 'zotero.sqlite')
}

/** An attachment path already resolved against the local storage layout. */
export interface ZoteroAttachmentRow {
  /** The path column verbatim (filename or URL), when present. */
  path: string | null
  linkMode: number
  contentType: string | null
  /** The attachment item's own key (= the storage/ subdirectory name). */
  key: string
  /** Absolute path on disk for imported files (null for URLs / unresolved). */
  absolutePath: string | null
}

/** Everything one item row carries, shaped for the host. */
export interface ZoteroRow {
  key: string
  itemID: number
  itemType: string
  libraryID: number
  dateAdded: string | null
  dateModified: string | null
  /** name → value map of all itemData fields (title, abstractNote, date, ...). */
  fields: Record<string, string>
  creators: Array<{ type: string; fieldMode: number; name: string; firstName?: string; lastName?: string }>
  tags: string[]
  attachments: ZoteroAttachmentRow[]
  /** Redundant flags derived from itemType (for host itemSummary / visibleItemRows). */
  isAttachment: boolean
  isNote: boolean
}

const NOTE_OR_ATTACH_IDS_SQL =
  "SELECT itemTypeID FROM itemTypes WHERE typeName IN ('note','attachment')"

/** Thrown when the live DB and a fresh snapshot both fail a lock or integrity read. */
export class ZoteroDbError extends Error {}

/**
 * A read-only reader over a specific SQLite snapshot file. It is pointed at a
 * stable snapshot path (maintained by `ZoteroSnapshotWatcher`) and does NOT
 * touch the live Zotero database. Construct one per connection, or keep one
 * and re-open after the snapshot is refreshed.
 *
 * All writes are forbidden (query_only). The reader never takes a lock on the
 * live library — it only opens its own snapshot file.
 */
export class ZoteroSqliteReader {
  private db: DatabaseSync | null = null
  private fields = new Map<number, string>()
  private types = new Map<number, string>()

  constructor(
    /** Absolute path to the SQLite snapshot file to read (never the live DB directly). */
    readonly dbPath: string,
    /** Zotero storage dir, used to resolve attachment absolute paths. */
    readonly dataDir: string = DATA_DIR,
  ) {}

  /**
   * Open the database read-only and build field/type maps. Throws if unreadable.
   * immutable opens the file in '?immutable=1' mode so a read-only reader can
   * query the LIVE zotero.sqlite even while Zotero holds a rollback-journal
   * write lock — no copy needed. Because immutable tells SQLite the file will
   * not change mid-connection, every reader that uses it MUST be short-lived:
   * run the query, close, and reopen for the next read.
   */
  open(immutable = false): this {
    if (this.db) return this
    const uri = immutable ? 'file:' + this.dbPath + '?immutable=1' : this.dbPath
    const db = new DatabaseSync(uri, { readOnly: true })
    try {
      db.exec('PRAGMA query_only = 1')
      db.exec('PRAGMA busy_timeout = 100')
      this.loadMaps(db)
      this.db = db
      return this
    } catch (err) {
      try { db.close() } catch {}
      throw err
    }
  }

  /** Close the current connection. */
  close(): void {
    try { this.db?.close() } catch {}
    this.db = null
  }

  get isOpen(): boolean { return this.db !== null }

  private loadMaps(db: DatabaseSync): void {
    this.fields = new Map(
      db.prepare('SELECT fieldID, fieldName FROM fields').all().map((r) => [Number(r.fieldID) as number, String(r.fieldName) as string]),
    )
    this.types = new Map(
      db.prepare('SELECT itemTypeID, typeName FROM itemTypes').all().map((r) => [Number(r.itemTypeID) as number, String(r.typeName) as string]),
    )
  }

  private get dbc(): DatabaseSync {
    if (!this.db) throw new Error('ZoteroSqliteReader not opened')
    return this.db
  }

  // ── Item shape ─────────────────────────────────────────────────────────────
  private datum(itemID: number): Record<string, string> {
    const rows = this.dbc.prepare(
      'SELECT d.fieldID, v.value FROM itemData d JOIN itemDataValues v ON d.valueID=v.valueID WHERE d.itemID = ?',
    ).all(itemID)
    const out: Record<string, string> = {}
    for (const r of rows) {
      const f = this.fields.get(Number(r.fieldID))
      if (f !== undefined) out[f] = String(r.value)
    }
    return out
  }

  private creators(itemID: number): ZoteroRow['creators'] {
    const rows = this.dbc.prepare(
      `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType
         FROM itemCreators ic
         JOIN creators c     ON ic.creatorID = c.creatorID
         JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
        WHERE ic.itemID = ? ORDER BY ic.orderIndex`,
    ).all(itemID)
    return rows.map((r) => {
      const fieldMode = Number(r.fieldMode)
      const firstName = r.firstName === null || r.firstName === undefined ? '' : String(r.firstName)
      const lastName = r.lastName === null || r.lastName === undefined ? '' : String(r.lastName)
      return {
        type: String(r.creatorType),
        fieldMode,
        name: fieldMode === 1 ? lastName : [firstName, lastName].filter(Boolean).join(' '),
        ...(fieldMode !== 1 && lastName ? { firstName, lastName } : {}),
      }
    })
  }

  private tags(itemID: number): string[] {
    return this.dbc.prepare(
      'SELECT t.name FROM itemTags it JOIN tags t ON it.tagID = t.tagID WHERE it.itemID = ?',
    ).all(itemID).map((r) => String(r.name))
  }

  private attachments(itemID: number): ZoteroAttachmentRow[] {
    return this.dbc.prepare(
      `SELECT a.itemID, i.key AS itemKey, a.parentItemID, a.path, a.linkMode, a.contentType
         FROM itemAttachments a JOIN items i ON a.itemID = i.itemID
        WHERE a.parentItemID = ?`,
    ).all(itemID).map((r) => {
      const path = r.path === null || r.path === undefined ? null : String(r.path)
      const linkMode = Number(r.linkMode)
      const itemKey = String(r.itemKey)
      let absolutePath: string | null = null
      if (path !== null) {
        if (linkMode === 0 || linkMode === 1) {
          absolutePath = join(this.dataDir, 'storage', itemKey, path.replace(/^storage:/, ''))
        } else {
          absolutePath = path // linked file / URL path
        }
      }
      return {
        path,
        linkMode,
        contentType: r.contentType === null || r.contentType === undefined ? null : String(r.contentType),
        key: itemKey,
        absolutePath,
      }
    })
  }

  /** Assemble one full item row (bibliographic fields + creators + tags + attachments). */
  item(itemID: number): ZoteroRow {
    const item = this.dbc.prepare('SELECT * FROM items WHERE itemID = ?').get(itemID)
    if (!item) throw new ZoteroDbError('item not found: ' + itemID)
    const typeName = this.types.get(Number(item.itemTypeID)) ?? String(item.itemTypeID)
    const fields = this.datum(itemID)
    const att = this.attachments(itemID)
    return {
      key: String(item.key),
      itemID: Number(item.itemID),
      itemType: typeName,
      libraryID: Number(item.libraryID),
      dateAdded: item.dateAdded === null || item.dateAdded === undefined ? null : String(item.dateAdded),
      dateModified: item.dateModified === null || item.dateModified === undefined ? null : String(item.dateModified),
      fields,
      creators: this.creators(itemID),
      tags: this.tags(itemID),
      attachments: att,
      isAttachment: typeName === 'attachment',
      isNote: typeName === 'note',
    }
  }

  /** The nested collection tree (with per-collection item counts). */
  collectionTree(): ZoteroCollectionNode[] {
    const rows = this.dbc.prepare(
      'SELECT collectionID, collectionName, parentCollectionID, libraryID, version, key FROM collections ORDER BY collectionName',
    ).all() as Array<Record<string, unknown>>
    const byId = new Map<number, ZoteroCollectionNode>()
    for (const r of rows) {
      const collectionID = Number(r.collectionID)
      const parent = r.parentCollectionID === null || r.parentCollectionID === undefined ? null : Number(r.parentCollectionID)
      byId.set(collectionID, {
        collectionID,
        key: String(r.key),
        collectionName: String(r.collectionName),
        parentCollectionID: parent,
        libraryID: Number(r.libraryID),
        version: Number(r.version),
        itemCount: this.countItems(collectionID),
        children: [],
      })
    }
    const roots: ZoteroCollectionNode[] = []
    for (const [id, node] of byId) {
      const parent = node.parentCollectionID === null ? null : byId.get(node.parentCollectionID)
      if (parent) (parent.children as ZoteroCollectionNode[]).push(node)
      else roots.push(node)
    }
    return roots
  }

  private countItems(collectionID: number): number {
    const row = this.dbc.prepare('SELECT COUNT(*) AS c FROM collectionItems WHERE collectionID = ?').get(collectionID)
    return row === undefined ? 0 : Number(row.c)
  }

  /** The itemIDs of a collection (bibliographic rows only, no notes/attachments, no deleted). */
  collectionItemIDs(collectionKey: string): { collectionName: string; itemIDs: number[] } {
    const coll = this.dbc.prepare('SELECT * FROM collections WHERE key = ?').get(collectionKey)
    if (!coll) throw new ZoteroDbError('collection not found: ' + collectionKey)
    const collectionID = Number(coll.collectionID)
    const rows = this.dbc.prepare(
      `SELECT i.itemID FROM collectionItems ci
         JOIN items i ON ci.itemID = i.itemID
        WHERE ci.collectionID = ?
          AND i.itemTypeID NOT IN (${NOTE_OR_ATTACH_IDS_SQL})
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        ORDER BY ci.orderIndex`,
    ).all(collectionID)
    return { collectionName: String(coll.collectionName), itemIDs: rows.map((r) => Number(r.itemID)) }
  }

  /** The itemIDs of the whole library (bibliographic only). */
  allLibraryItemIDs(): number[] {
    const rows = this.dbc.prepare(
      `SELECT itemID FROM items
         WHERE itemTypeID NOT IN (${NOTE_OR_ATTACH_IDS_SQL})
           AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
    ).all()
    return rows.map((r) => Number(r.itemID))
  }

  /** One item by its key (or undefined). */
  itemByKey(key: string): ZoteroRow | undefined {
    const item = this.dbc.prepare('SELECT * FROM items WHERE key = ?').get(key)
    if (!item) return undefined
    return this.item(Number(item.itemID))
  }

  /**
   * LIKE search across item fields / creators / tags / key. Returns full rows.
   * Cheap but "contains" semantics — good enough for the sidebar picker.
   */
  search(query: string, limit = 50): ZoteroRow[] {
    const q = query.trim()
    if (q === '') return []
    const like = `%${q}%`
    const seen = new Set<number>()
    const ids: number[] = []
    const push = (id: number) => { if (!seen.has(id)) { seen.add(id); ids.push(id) } }

    const keyHit = this.dbc.prepare('SELECT itemID FROM items WHERE key = ? LIMIT 1').get(q)
    if (keyHit) push(Number(keyHit.itemID))
    for (const r of this.dbc.prepare(
      `SELECT DISTINCT d.itemID FROM itemData d JOIN itemDataValues v ON d.valueID=v.valueID
        WHERE v.value LIKE ? COLLATE NOCASE`,
    ).all(like)) push(Number(r.itemID))
    for (const r of this.dbc.prepare(
      `SELECT DISTINCT i.itemID FROM itemCreators ic
        JOIN creators c ON ic.creatorID=c.creatorID
        JOIN items i ON ic.itemID=i.itemID
        WHERE c.lastName LIKE ? OR c.firstName LIKE ? COLLATE NOCASE`,
    ).all(like, like)) push(Number(r.itemID))
    for (const r of this.dbc.prepare(
      `SELECT DISTINCT it.itemID FROM itemTags it JOIN tags t ON it.tagID=t.tagID
        WHERE t.name LIKE ? COLLATE NOCASE`,
    ).all(like)) push(Number(r.itemID))

    return ids.slice(0, limit).map((id) => this.item(id))
  }

/**
   * One-shot, batched load of the ENTIRE library into a plain in-memory
   * structure. Unlike the per-item reader methods (which do N+1 queries), this
   * pulls every table once in a handful of bulk queries, so the caller can hold
   * the whole library in memory and answer tree/expand/search/resolve without
   * ever touching SQLite again. Recomputed in ~60-90ms even for large libraries.
   */
  loadLibrary(): ZoteroLibrary {
    const db = this.dbc
    const NA = `SELECT itemTypeID FROM itemTypes WHERE typeName IN ('note','attachment')`

    // Collections (with keys, parents, per-collection direct item counts).
    const collections = db.prepare(
      `SELECT c.collectionID, c.collectionName, c.parentCollectionID, c.libraryID,
              c.version, c.key,
              (SELECT COUNT(*) FROM collectionItems ci WHERE ci.collectionID = c.collectionID) AS itemCount
         FROM collections c ORDER BY c.collectionName`,
    ).all() as Array<Record<string, unknown>>

    // All bibliographic items (no notes/attachments/deleted).
    const itemRows = db.prepare(
      `SELECT * FROM items
         WHERE itemTypeID NOT IN (${NA})
           AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
    ).all() as Array<Record<string, unknown>>

    const typeNames = new Map<number, string>(this.types)

    // Bulk field data: itemID -> {fieldName -> value}
    const fieldsByItem = new Map<number, Record<string, string>>()
    for (const r of db.prepare(
      `SELECT d.itemID, d.fieldID, v.value
         FROM itemData d JOIN itemDataValues v ON d.valueID = v.valueID`,
    ).all() as Array<Record<string, unknown>>) {
      const id = Number(r.itemID)
      const fname = this.fields.get(Number(r.fieldID))
      if (fname === undefined) continue
      let m = fieldsByItem.get(id)
      if (!m) { m = {}; fieldsByItem.set(id, m) }
      m[fname] = String(r.value)
    }

    // Bulk creators: itemID -> creators
    const creatorsByItem = new Map<number, ZoteroRow['creators']>()
    for (const r of db.prepare(
      `SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, ct.creatorType
         FROM itemCreators ic
         JOIN creators c     ON ic.creatorID = c.creatorID
         JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
        ORDER BY ic.orderIndex`,
    ).all() as Array<Record<string, unknown>>) {
      const id = Number(r.itemID)
      const fieldMode = Number(r.fieldMode)
      const firstName = r.firstName == null ? '' : String(r.firstName)
      const lastName = r.lastName == null ? '' : String(r.lastName)
      const creator = {
        type: String(r.creatorType),
        fieldMode,
        name: fieldMode === 1 ? lastName : [firstName, lastName].filter(Boolean).join(' '),
        ...(fieldMode !== 1 && lastName ? { firstName, lastName } : {}),
      }
      let arr = creatorsByItem.get(id)
      if (!arr) { arr = []; creatorsByItem.set(id, arr) }
      arr.push(creator)
    }

    // Bulk tags: itemID -> string[]
    const tagsByItem = new Map<number, string[]>()
    for (const r of db.prepare(
      `SELECT it.itemID, t.name FROM itemTags it JOIN tags t ON it.tagID = t.tagID ORDER BY it.itemID`,
    ).all() as Array<Record<string, unknown>>) {
      const id = Number(r.itemID)
      let arr = tagsByItem.get(id)
      if (!arr) { arr = []; tagsByItem.set(id, arr) }
      arr.push(String(r.name))
    }

    // Bulk attachments: parentItemID + itemKey for path resolution
    const attByParent = new Map<number, ZoteroAttachmentRow[]>()
    for (const r of db.prepare(
      `SELECT a.itemID, i.key AS itemKey, a.parentItemID, a.path, a.linkMode, a.contentType
         FROM itemAttachments a JOIN items i ON a.itemID = i.itemID`,
    ).all() as Array<Record<string, unknown>>) {
      const parent = r.parentItemID == null ? null : Number(r.parentItemID)
      if (parent === null) continue
      const path = r.path == null ? null : String(r.path)
      const linkMode = Number(r.linkMode)
      const itemKey = String(r.itemKey)
      let absolutePath: string | null = null
      if (path !== null) {
        absolutePath = linkMode === 0 || linkMode === 1
          ? join(this.dataDir, 'storage', itemKey, path.replace(/^storage:/, ''))
          : path
      }
      const att: ZoteroAttachmentRow = {
        path, linkMode,
        contentType: r.contentType == null ? null : String(r.contentType),
        key: itemKey,
        absolutePath,
      }
      let arr = attByParent.get(parent)
      if (!arr) { arr = []; attByParent.set(parent, arr) }
      arr.push(att)
    }

    // Bulk collection membership: collectionID -> itemID[] (with order)
    const collItems = new Map<number, number[]>()
    for (const r of db.prepare(
      `SELECT ci.collectionID, ci.itemID FROM collectionItems ci ORDER BY ci.collectionID, ci.orderIndex`,
    ).all() as Array<Record<string, unknown>>) {
      const cid = Number(r.collectionID)
      let arr = collItems.get(cid)
      if (!arr) { arr = []; collItems.set(cid, arr) }
      arr.push(Number(r.itemID))
    }

    // Assemble rows + indices
    const collectionsById = new Map<number, ZoteroCollectionNode>()
    const collectionByKey = new Map<string, number>()
    for (const r of collections) {
      const id = Number(r.collectionID)
      const node: ZoteroCollectionNode = {
        collectionID: id,
        key: String(r.key),
        collectionName: String(r.collectionName),
        parentCollectionID: r.parentCollectionID == null ? null : Number(r.parentCollectionID),
        libraryID: Number(r.libraryID),
        version: Number(r.version),
        itemCount: Number(r.itemCount),
        children: [],
      }
      collectionsById.set(id, node)
      collectionByKey.set(node.key, id)
    }
    const tree = buildCollectionTree(collectionsById)

    const itemsByID = new Map<number, ZoteroRow>()
    const itemsByKey = new Map<string, ZoteroRow>()
    for (const item of itemRows) {
      const itemID = Number(item.itemID)
      const typeName = typeNames.get(Number(item.itemTypeID)) ?? String(item.itemTypeID)
      const row: ZoteroRow = {
        key: String(item.key),
        itemID,
        itemType: typeName,
        libraryID: Number(item.libraryID),
        dateAdded: item.dateAdded == null ? null : String(item.dateAdded),
        dateModified: item.dateModified == null ? null : String(item.dateModified),
        fields: fieldsByItem.get(itemID) ?? {},
        creators: creatorsByItem.get(itemID) ?? [],
        tags: tagsByItem.get(itemID) ?? [],
        attachments: attByParent.get(itemID) ?? [],
        isAttachment: typeName === 'attachment',
        isNote: typeName === 'note',
      }
      itemsByID.set(itemID, row)
      itemsByKey.set(row.key, row)
    }

    return {
      tree, collectionsById, collectionByKey, collectionItems: collItems,
      itemsByID, itemsByKey, allItemIDs: [...itemsByID.keys()],
    }
  }
}

/** Build the nested collection tree from a flat id->node map (children attached in place). */
function buildCollectionTree(byId: Map<number, ZoteroCollectionNode>): ZoteroCollectionNode[] {
  const roots: ZoteroCollectionNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentCollectionID == null ? null : byId.get(node.parentCollectionID)
    if (parent) (parent.children as ZoteroCollectionNode[]).push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * A fully in-memory snapshot of a Zotero library, produced by
 * ZoteroSqliteReader.loadLibrary(). Once built, every read (tree, expand,
 * search, resolve) is served from these maps with zero SQLite traffic.
 */
export interface ZoteroLibrary {
  /** Nested collection tree (roots -> children recursively). */
  tree: ZoteroCollectionNode[]
  /** collectionID -> node. */
  collectionsById: Map<number, ZoteroCollectionNode>
  /** collection key -> collectionID. */
  collectionByKey: Map<string, number>
  /** collectionID -> itemIDs (direct members, incl. order). */
  collectionItems: Map<number, number[]>
  /** itemID -> full row. */
  itemsByID: Map<number, ZoteroRow>
  /** item key -> row. */
  itemsByKey: Map<string, ZoteroRow>
  /** All bibliographic itemIDs. */
  allItemIDs: number[]
}

/**
 * Options for `ZoteroSnapshotWatcher`.
 */
export interface ZoteroWatcherOptions {
  /** Where to keep the managed snapshot file. Defaults to the OS temp dir. */
  cacheDir?: string
  /** Debounce window after a live-file change before copying (ms). */
  debounceMs?: number
  /** Re-copy at most once per this interval (ms), to ride out write bursts. */
  minIntervalMs?: number
  /** Fallback polling interval when fs.watch is unavailable (ms). */
  pollMs?: number
}

/**
 * Watcher that keeps an up-to-date, atomically-replaced copy of the Zotero DB
 * in a stable snapshot file, decoupling all plugin reads from the live
 * `zotero.sqlite` (which we must never write or read mid-write).
 *
 *   - Monitors the live DB with `fs.watch`; falls back to stat polling.
 *   - On change (debounced), copies to a sibling temp file in the cache dir
 *     then renames it over the snapshot — atomic, so a reader always opens a
 *     complete file.
 *   - `ensureSnapshot()` guarantees a snapshot exists up front (copies now if
 *     needed), and a reader can be opened against the snapshot path.
 *
 * The only writes performed are to the cache dir — never to Zotero's files.
 */
export class ZoteroSnapshotWatcher {
  readonly snapshotPath: string
  private watcher: ReturnType<typeof watch> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private copying = false
  private lastCopyMs = 0
  private destroyed = false
  private lastLiveMtimeMs = 0

  constructor(private readonly liveDbPath: string, private readonly options: ZoteroWatcherOptions = {}) {
    const dir = options.cacheDir ?? join(tmpdir(), 'dsh-zotero-snapshot')
    if (this.options.cacheDir) mkdirSync(dir, { recursive: true })
    else { try { mkdirSync(dir, { recursive: true }) } catch { /* readonly fallback below */ } }
    this.snapshotPath = join(dir, 'zotero.sqlite')
    this.lastLiveMtimeMs = this.liveMtime()
  }

  /** Start monitoring. Call once after construction (or let ensureSnapshot lazily copy). */
  start(): this {
    if (this.destroyed) throw new Error('watcher destroyed')
    try {
      const target = realpathSync(this.liveDbPath)
      this.watcher = watch(target, (event) => {
        if (event === 'rename') setTimeout(() => this.schedule(), 200)
        else this.schedule()
      })
      this.watcher.on('error', () => this.enablePolling())
    } catch {
      this.enablePolling()
    }
    return this
  }

  private enablePolling(): void {
    if (this.pollTimer) return
    const ms = this.options.pollMs ?? 2000
    this.pollTimer = setInterval(() => this.schedule(), ms)
    this.pollTimer.unref?.()
  }

  private schedule(): void {
    if (this.copying || this.destroyed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const debounceMs = this.options.debounceMs ?? 500
    this.debounceTimer = setTimeout(() => void this.copy(), debounceMs)
  }

  /** The current mtime of the live DB (0 if missing). */
  private liveMtime(): number {
    try { return statSync(this.liveDbPath).mtimeMs } catch { return 0 }
  }

  /**
   * Copy the live DB to the snapshot path atomically (temp + rename). Skips if
   * a copy happened recently. Returns true when the snapshot file changed.
   */
  copy(): boolean {
    if (this.copying || this.destroyed) return false
    const now = Date.now()
    const minIntervalMs = this.options.minIntervalMs ?? 1000
    if (now - this.lastCopyMs < minIntervalMs) return false
    if (!existsSync(this.liveDbPath)) {
      // Zotero may be gone; keep the last good snapshot.
      return false
    }
    const dir = this.snapshotPath.slice(0, -'/zotero.sqlite'.length)
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    const tmp = this.snapshotPath + '.tmp'
    let changed = false
    this.copying = true
    try {
      copyFileSync(this.liveDbPath, tmp)
      renameSync(tmp, this.snapshotPath)
      this.lastCopyMs = Date.now()
      this.lastLiveMtimeMs = this.liveMtime()
      changed = true
    } catch {
      try { unlinkSync(tmp) } catch {}
    } finally {
      this.copying = false
    }
    return changed
  }

  /**
   * Make sure a usable snapshot exists right now (copies from the live DB if the
   * snapshot is missing or older than the live file). Returns the snapshot path.
   */
  ensureSnapshot(): string {
    if (!existsSync(this.snapshotPath) || this.snapshotOlderThanLive()) {
      this.copy()
    }
    return this.snapshotPath
  }

  private snapshotOlderThanLive(): boolean {
    try {
      return statSync(this.snapshotPath).mtimeMs < statSync(this.liveDbPath).mtimeMs
    } catch { return true }
  }

  /** Open a reader over the current snapshot without holding it open. */
  makeReader(): ZoteroSqliteReader {
    return new ZoteroSqliteReader(this.snapshotPath, dirname(this.liveDbPath)).open()
  }

  destroy(): void {
    this.destroyed = true
    if (this.watcher) { try { this.watcher.close() } catch {} this.watcher = null }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
  }

  /** The absolute path of the live Zotero DB (needed for immutable reads). */
  livePath(): string {
    return this.liveDbPath
  }

  /** mtime stamp of the LIVE Zotero DB — the freshness signal for immutable reads. */
  liveStamp(): number {
    try { return statSync(this.liveDbPath).mtimeMs } catch { return 0 }
  }

  /** mtime stamp of the current snapshot file (0 if none). */
  snapshotStamp(): number {
    try { return statSync(this.snapshotPath).mtimeMs } catch { return 0 }
  }
}



/**
 * The plugin-side snapshot cache: one watcher + one reusable reader over the
 * snapshot, re-opened whenever the watcher refreshes the file.
 */
export class ZoteroSnapshotCache {
  private reader: ZoteroSqliteReader | null = null
  private lastSampleMs = 0
  constructor(
    readonly watcher: ZoteroSnapshotWatcher,
    private readonly dataDir: string = DATA_DIR,
    /** Re-open the reader at most every `reopenIntervalMs`. */
    private readonly reopenIntervalMs = 2000,
  ) {}

  /** A reader over the current snapshot; re-opened shortly after a refresh. */
  getReader(): ZoteroSqliteReader {
    const now = Date.now()
    if (!this.reader || now - this.lastSampleMs > this.reopenIntervalMs) {
      // Re-open to pick up a fresher snapshot (atomic replace means we never see half a file).
      this.reader?.close()
      try { this.reader = this.watcher.makeReader() } catch { this.reader = null }
      this.lastSampleMs = now
    }
    if (!this.reader) {
      const path = this.watcher.ensureSnapshot()
      this.reader = new ZoteroSqliteReader(path, this.dataDir).open()
    }
    return this.reader
  }

  /** Force the watcher to re-copy from the live DB now and reopen. */
  forceRefresh(): void {
    if (this.watcher.copy()) {
      this.reader?.close()
      this.reader = null
      this.lastSampleMs = 0
    }
  }

  /**
   * Run a reader function; on a DB error that a fresh copy would fix, ask the
   * watcher to re-copy once and retry. Guards against a stray bad snapshot.
   */
  withFreshRetry<T>(fn: (reader: ZoteroSqliteReader) => T): T {
    try {
      return fn(this.getReader())
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      const retryable = /corrupt|malformed|no such table|database is locked|disk I\/O error/i.test(msg)
      if (!retryable) throw err
      this.watcher.copy()
      this.reader?.close()
      this.reader = null
      return fn(this.getReader())
    }
  }

  get snapshotPath(): string { return this.watcher.snapshotPath }

  /**
   * A change stamp = the LIVE DB file mtime. Reads in immutable mode hit the
   * live file directly, so this (not the snapshot file's mtime) is the signal
   * the host uses to decide whether the in-memory library must be rebuilt.
   */
  snapshotStamp(): number {
    return this.watcher.liveStamp()
  }

  /**
   * Run a full-library reader against the LIVE zotero.sqlite using immutable
   * mode (no 95MB copy, bypasses Zotero's rollback-journal lock). Each call
   * opens a fresh short-lived immutable connection, runs fn, then closes —
   * exactly what immutable's "file never changes mid-connection" contract
   * requires. Falls back to the copied snapshot if the live read fails.
   *
   * Returns a tuple [result, changed] where changed=true when the live file
   * had been touched since the caller's last read (mtime moved on).
   */
  readLiveImmutable<T>(fn: (r: import('./zotero-sqlite.js').ZoteroSqliteReader) => T, lastLiveStamp = -1): { value: T; changed: boolean } {
    const live = this.watcher.livePath()
    const nowLive = this.watcher.liveStamp()
    try {
      const reader = new ZoteroSqliteReader(live, this.dataDir).open(true)
      try {
        return { value: fn(reader), changed: nowLive !== lastLiveStamp }
      } finally {
        reader.close()
      }
    } catch (err) {
      // Live immutable read failed (missing, corrupt, or lock we can't bypass):
      // fall back to a copy-on-read snapshot for a consistent view.
      const path = this.watcher.ensureSnapshot()
      const reader = new ZoteroSqliteReader(path, this.dataDir).open()
      try {
        return { value: fn(reader), changed: nowLive !== lastLiveStamp }
      } finally {
        reader.close()
      }
    }
  }

  close(): void {
    this.reader?.close()
    this.reader = null
    this.watcher.destroy()
  }
}

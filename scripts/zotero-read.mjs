#!/usr/bin/env node
/**
 * zotero-read.mjs — read your local Zotero library directly from its SQLite
 * database, WITHOUT Zotero running an add-on.
 *
 * Zero dependencies: uses Node's built-in `node:sqlite` (Node >= 22.5, ideally
 * >= 24 which does not need the experimental flag).
 *
 * It does NOT write to the live zotero.sqlite. To dodge Zotero's exclusive
 * write lock while the app is running, it first tries the live file with a
 * busy timeout; if that is still locked it copies the file into your OS temp
 * dir and reads the copy.
 *
 * Usage:
 *   node scripts/zotero-read.mjs tree                # collection hierarchy
 *   node scripts/zotero-read.mjs list <collKey>      # items of one collection
 *   node scripts/zotero-read.mjs get  <itemKey>      # full detail of one item
 *   node scripts/zotero-read.mjs search <query>      # full-text-ish item search
 *   node scripts/zotero-read.mjs stats               # counts summary
 *
 * Environment:
 *   ZOTERO_DATA_DIR  override the Zotero data dir (default ~/Zotero)
 *   ZOTERO_DB        override the exact sqlite path
 *
 * The JSON schema mirrors what Zotero's own API would give you but is read
 * straight off the local tables.
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, copyFileSync, mkdtempSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

// ── DB location ─────────────────────────────────────────────────────────────
const DATA_DIR = process.env.ZOTERO_DATA_DIR ?? join(homedir(), 'Zotero')
let DB_PATH = process.env.ZOTERO_DB ?? join(DATA_DIR, 'zotero.sqlite')

const SNAPSHOT_PATH = process.env.ZOTERO_SNAPSHOT || undefined

/** Open read-only. Prefer an explicit snapshot; else the live file, else copy-on-lock. */
function open() {
  const db = new DatabaseSync(SNAPSHOT_PATH || DB_PATH, { readOnly: true })
  db.exec('PRAGMA query_only = 1')
  return db
}

/** If a SQLite statement reports `database is locked`, rebuild from a temp copy and retry the whole command once. */
function tryLockFallback(handler, arg1) {
  const attempt = (db) => handler(db, arg1)
  let db
  try {
    db = open()
    return attempt(db)
  } catch (err) {
    const isLock = typeof err === 'object' && err !== null && /locked/i.test(String(err.message))
    if (!isLock) throw err
    // copy snapshot and retry
    if (!existsSync(DB_PATH)) throw new Error('Zotero database not found at ' + DB_PATH)
    const dir = mkdtempSync(join(tmpdir(), 'zotero-read-'))
    const copy = join(dir, 'zotero.sqlite')
    try { copyFileSync(DB_PATH, copy) } catch (e) { throw e }
    try { db?.close() } catch {}
    db = new DatabaseSync(copy, { readOnly: true })
    db.exec('PRAGMA query_only = 1')
    process.on('exit', () => {
      try { db.close() } catch {}
      try { unlinkSync(copy) } catch {}
    })
    return attempt(db)
  }
}

// ── SQL helpers ─────────────────────────────────────────────────────────────
const caches = {}
function maps(db) {
  if (!caches.db || caches.db !== db) {
    caches.db = db
    caches.fields = new Map(db.prepare('SELECT fieldID,fieldName FROM fields').all().map(r => [r.fieldID, r.fieldName]))
    caches.types = new Map(db.prepare('SELECT itemTypeID,typeName FROM itemTypes').all().map(r => [r.itemTypeID, r.typeName]))
  }
  return caches
}

/** All non-deleted items' field data grouped by itemID. */
const NOTE_OR_ATTACH_IDS = (() =>
  "SELECT itemTypeID FROM itemTypes WHERE typeName IN ('note','attachment')")()

/** Collapse an item's datum into {fieldName: value}; map creator-type column to a readable name lazily. */
function itemDatum(db, itemID) {
  const { fields } = maps(db)
  const rows = db.prepare(
    `SELECT d.fieldID, v.value FROM itemData d
       JOIN itemDataValues v ON d.valueID = v.valueID
      WHERE d.itemID = ?`,
  ).all(itemID)
  const out = {}
  for (const r of rows) out[fields.get(r.fieldID)] = r.value
  return out
}

function itemCreators(db, itemID) {
  const rows = db.prepare(
    `SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType
       FROM itemCreators ic
       JOIN creators c     ON ic.creatorID = c.creatorID
       JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
      WHERE ic.itemID = ? ORDER BY ic.orderIndex`,
  ).all(itemID)
  return rows.map(r => ({
    type: r.creatorType,
    fieldMode: r.fieldMode,
    name: r.fieldMode === 1
      ? (r.lastName ?? '')
      : [r.firstName, r.lastName].filter(Boolean).join(' '),
    ...(r.fieldMode !== 1 && r.lastName ? { firstName: r.firstName, lastName: r.lastName } : {}),
  }))
}

function itemTags(db, itemID) {
  return db.prepare(
    'SELECT t.name FROM itemTags it JOIN tags t ON it.tagID = t.tagID WHERE it.itemID = ?',
  ).all(itemID).map(r => r.name)
}

function itemAttachments(db, itemID) {
  return db.prepare(
    `SELECT a.itemID, i.key AS itemKey, a.parentItemID, a.path, a.linkMode, a.contentType
       FROM itemAttachments a JOIN items i ON a.itemID = i.itemID
      WHERE a.parentItemID = ?`,
  ).all(itemID).map(r => ({
    path: typeof r.path === 'string' ? r.path : null,
    linkMode: r.linkMode,
    contentType: r.contentType,
    key: r.itemKey,
    absolutePath: resolveAttachmentPath(r, itemID),
  }))
}

/**
 * Resolve an attachment row into an absolute path on disk.
 * Storage layout: <data>/storage/<attachmentItemKey>/<filename>.
 * `path` carries the filename (or URL) part; linkMode tells the meaning:
 *   0 imported_file   → storage/<key>/<filename>
 *   1 imported_url     → storage/<key>/<filename> (snapshot saved under the key dir)
 *   2 linked_file      → path is an absolute/relative file path
 *   3 linked_url       → path is a URL (not a file)
 */
function resolveAttachmentPath(row, parentItemID) {
  const path = typeof row.path === 'string' ? row.path : null
  if (path === null || path === undefined) return null
  const linkMode = row.linkMode
  if (linkMode === 2) return path // linked file: path is the real file path
  if (linkMode === 3) return path // linked url: path is a URL
  // imported file/url: stored under <data>/storage/<attachmentItemKey>/
  const key = row.itemKey
  const filename = path.replace(/^storage:/, '')
  return join(DATA_DIR, 'storage', key, filename)
}

function itemRow(db, itemID) {
  const { types } = maps(db)
  const item = db.prepare('SELECT * FROM items WHERE itemID = ?').get(itemID)
  const datum = itemDatum(db, itemID)
  const detail = {
    key: item.key,
    itemID: item.itemID,
    itemType: types.get(item.itemTypeID) ?? String(item.itemTypeID),
    libraryID: item.libraryID,
    dateAdded: item.dateAdded,
    dateModified: item.dateModified,
    fields: datum,
    creators: itemCreators(db, itemID),
    tags: itemTags(db, itemID),
  }
  const att = itemAttachments(db, itemID)
  if (att.length) detail.attachments = att
  return detail
}

// ── Commands ────────────────────────────────────────────────────────────────
const commands = {

  /** Nested collection tree. */
  tree(db) {
    const rows = db.prepare(
      `SELECT c.collectionID, c.collectionName, c.parentCollectionID, c.key
         FROM collections c ORDER BY c.collectionName`,
    ).all()
    const byId = new Map(rows.map(r => [r.collectionID, { ...r, children: [] }]))
    const roots = []
    for (const r of rows) {
      const node = byId.get(r.collectionID)
      const parent = r.parentCollectionID === null ? null : byId.get(r.parentCollectionID)
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    const count = (id) => db.prepare(
      'SELECT COUNT(*) c FROM collectionItems WHERE collectionID = ?', { readBigInts: false }).get(id).c
    const decorate = (n) => ({ key: n.key, name: n.collectionName, itemCount: count(n.collectionID), children: n.children.map(decorate) })
    return roots.map(decorate)
  },

  /** Items of a collection key (real bibliographic items only, not notes/attachments). */
  list(db, collKey) {
    const coll = db.prepare('SELECT * FROM collections WHERE key = ?').get(collKey)
    if (!coll) throw new Error(`collection not found: ${collKey}`)
    const rows = db.prepare(
      `SELECT i.itemID FROM collectionItems ci
         JOIN items i ON ci.itemID = i.itemID
        WHERE ci.collectionID = ?
          AND i.itemTypeID NOT IN (${NOTE_OR_ATTACH_IDS})
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        ORDER BY ci.orderIndex`,
    ).all(coll.collectionID)
    return { collection: { key: coll.key, name: coll.collectionName }, items: rows.map(r => itemRow(db, r.itemID)) }
  },

  /** Full detail of one item by key (any item, incl. notes/attachments). */
  get(db, itemKey) {
    const item = db.prepare('SELECT * FROM items WHERE key = ?').get(itemKey)
    if (!item) throw new Error(`item not found: ${itemKey}`)
    return itemRow(db, item.itemID)
  },

  /** SQL LIKE search over title / creators / tags / all datum values. */
  search(db, query) {
    const like = `%${query}%`
    const keyFirst = db.prepare('SELECT itemID FROM items WHERE key = ? LIMIT 1').get(query)
    const candidates = keyFirst ? [keyFirst.itemID] : []
    for (const r of db.prepare(
      `SELECT DISTINCT d.itemID FROM itemData d JOIN itemDataValues v ON d.valueID=v.valueID
        WHERE v.value LIKE ? COLLATE NOCASE`,
    ).all(like)) candidates.push(r.itemID)
    for (const r of db.prepare(
      `SELECT DISTINCT i.itemID FROM itemCreators ic
        JOIN creators c ON ic.creatorID=c.creatorID
        JOIN items i ON ic.itemID=i.itemID
        WHERE c.lastName LIKE ? OR c.firstName LIKE ? COLLATE NOCASE`,
    ).all(like, like)) {
      if (!candidates.includes(r.itemID)) candidates.push(r.itemID)
    }
    const results = []
    for (const id of candidates) {
      const row = db.prepare('SELECT itemID, itemTypeID FROM items WHERE itemID = ?').get(id)
      results.push(itemRow(db, id))
    }
    return { query, count: results.length, results }
  },

  /** Stats: counts of items, collections, first-level structure. */
  stats(db) {
    const one = (sql) => db.prepare(sql).get().c
    return {
      dbPath: DB_PATH,
      collections: one('SELECT COUNT(*) c FROM collections'),
      items: one('SELECT COUNT(*) c FROM items'),
      bibliographic: one(`
        SELECT COUNT(*) c FROM items WHERE itemTypeID NOT IN (${NOTE_OR_ATTACH_IDS})
          AND itemID NOT IN (SELECT itemID FROM deletedItems)`),
      notes: one(`SELECT COUNT(*) c FROM items WHERE itemTypeID IN (${NOTE_OR_ATTACH_IDS})`),
      attachments: one('SELECT COUNT(*) c FROM itemAttachments'),
      deletedItems: one('SELECT COUNT(*) c FROM items WHERE itemID IN (SELECT itemID FROM deletedItems)'),
      fieldRows: one('SELECT COUNT(*) c FROM itemData'),
    }
  },
}

// ── main ────────────────────────────────────────────────────────────────────
function usage() {
  console.error(`Usage:  node zotero-read.mjs tree  node zotero-read.mjs list <collectionKey>  node zotero-read.mjs get  <itemKey>  node zotero-read.mjs search <query>  node zotero-read.mjs stats`)
  process.exit(1)
}

const [cmd, arg1] = process.argv.slice(2)
if (!cmd) usage()
if (!commands[cmd]) usage()

let db
try {
  const out = tryLockFallback(commands[cmd], arg1)
  console.log(JSON.stringify(out, null, 2))
} finally {
  try { db?.close() } catch {}
}

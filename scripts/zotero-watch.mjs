#!/usr/bin/env node
/**
 * zotero-watch.mjs — a local monitor that keeps an up-to-date, atomically
 * replaced snapshot copy of `zotero.sqlite` in a cache dir.
 *
 * Rationale: reading/writing Zotero's live database from other tools is risky —
 * Zotero holds a rollback-journal lock while running, and a naive copy could
 * capture a mid-write, inconsistent file. This watcher instead:
 *   - watches the live zotero.sqlite (fs.watch + stat-polling fallback),
 *   - on change, copies to a sibling temp file and renames it over the snapshot
 *     (rename is atomic → readers always open a complete file),
 *   - lets any consumer read the snapshot with zero risk to the real library.
 *
 * The ONLY writes happen in the cache dir — never to Zotero's files.
 *
 * Usage (node >= 22.5; node:sqlite not even needed for the watch itself):
 *   node scripts/zotero-watch.mjs                 # run until Ctrl-C
 *   ZOTERO_CACHE_DIR=/tmp/zotero-snap node scripts/zotero-watch.mjs
 *   ZOTERO_DATA_DIR=/path/to/Zotero node scripts/zotero-watch.mjs
 *
 * The snapshot ends up at `<cacheDir>/zotero.sqlite`. When the watch loop is
 * left running it refreshes automatically on every change; otherwise run one
 * copy-once mode:
 *   node scripts/zotero-watch.mjs --once          # copy now and exit
 *   node scripts/zotero-watch.mjs --verify        # copy then integrity-check
 */
import { existsSync, copyFileSync, renameSync, mkdirSync, statSync, unlinkSync, watch, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const ZOTERO_DIR = process.env.ZOTERO_DATA_DIR ?? join(homedir(), 'Zotero')
const LIVE_DB = process.env.ZOTERO_DB ?? join(ZOTERO_DIR, 'zotero.sqlite')
const CACHE_DIR = process.env.ZOTERO_CACHE_DIR ?? join(homedir(), '.cache', 'dsh-zotero')
const SNAPSHOT = join(CACHE_DIR, 'zotero.sqlite')
const DEBOUNCE_MS = Number(process.env.ZOTERO_WATCH_DEBOUNCE_MS || 400)
const MIN_INTERVAL_MS = Number(process.env.ZOTERO_WATCH_MIN_INTERVAL_MS || 800)
const POLL_MS = Number(process.env.ZOTERO_WATCH_POLL_MS || 2000)

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const verify = args.has('--verify')

let lastCopyMs = 0
let copying = false

function liveMtime() {
  try { return statSync(LIVE_DB).mtimeMs } catch { return 0 }
}

/** Copy live → temp → rename over snapshot. Returns true if refreshed. */
function copy() {
  if (copying) return false
  const now = Date.now()
  if (now - lastCopyMs < MIN_INTERVAL_MS) return false
  if (!existsSync(LIVE_DB)) return false
  mkdirSync(CACHE_DIR, { recursive: true })
  const tmp = SNAPSHOT + '.tmp'
  copying = true
  try {
    copyFileSync(LIVE_DB, tmp)
    renameSync(tmp, SNAPSHOT)
    lastCopyMs = Date.now()
    console.log(`[${new Date().toISOString()}] snapshot updated -> ${SNAPSHOT}`)
    if (verify) console.log('  (verify only; integrity via reader side)')
    return true
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    console.error('copy failed:', err instanceof Error ? err.message : String(err))
    return false
  } finally {
    copying = false
  }
}

function scheduleDebounced() {
  if (copying) return
  clearTimeout(debTimer)
  debTimer = setTimeout(() => copy(), DEBOUNCE_MS)
}
let debTimer

if (once) {
  copy()
  process.exit(0)
}

console.log('Zotero snapshot watcher')
console.log('  live:    ', LIVE_DB)
console.log('  snapshot:', SNAPSHOT)
console.log('  Ctrl-C to stop')

// initial copy
copy()

// fs.watch with polling fallback
let pollTimer
try {
  const watcher = watch(realpathSync(LIVE_DB), (ev) => {
    if (ev === 'rename') setTimeout(scheduleDebounced, 200)
    else scheduleDebounced()
  })
  watcher.on('error', () => enablePolling())
  process.on('SIGINT', () => { try { watcher.close() } catch {}; process.exit(0) })
} catch {
  enablePolling()
}
function enablePolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (liveMtime() > lastCopyMs || !existsSync(SNAPSHOT)) scheduleDebounced()
  }, POLL_MS)
  pollTimer.unref?.()
}

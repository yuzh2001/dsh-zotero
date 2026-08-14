/**
 * The client-side Zotero data store: a per-path node registry plus a
 * localStorage cache. It mirrors the host's authoritative descriptors so the
 * tree can render instantly on revisits, and it paces lazy item loads through
 * a small async queue (the "controlled traversal speed") rather than firing
 * unbounded parallel zotero-cli calls.
 *
 * Only lossless plain data (ZoteroNodeDescriptor) is stored — never live
 * objects.
 */
import { zoteroApi, ZoteroApiError } from './zotero-api.js'
import type { ZoteroLibraryTreeResult, ZoteroNodeDescriptor } from '../shared.js'

/** localStorage key for the eagerly-loaded collection hierarchy. */
const TREE_KEY = 'dsa-zotero:tree:v1'
/** localStorage key prefix for a collection's loaded item descriptors. */
const ITEMS_KEY_PREFIX = 'dsa-zotero:items:'
/** How many items are fetched in the first async pass of an expansion. */
export const FIRST_PAGE = 25
/** Max bytes to keep in localStorage for one collection's item list. */
const ITEM_CACHE_BYTES = 512 * 1024

function safeParse<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function safeRead(key: string): unknown {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage full / unavailable — fail silently, the tree still works in-memory */
  }
}

/**
 * The tree + items store. One instance per sidebar tab activation.
 */
export class ZoteroStore {
  /** path -> node descriptor (collections + loaded items). */
  readonly nodes = new Map<string, ZoteroNodeDescriptor>()
  /** collection path -> its item paths (loaded so far). */
  private readonly itemsByCollection = new Map<string, string[]>()

  /** Loading states per collection path. */
  private readonly loading = new Set<string>()
  private readonly loaded = new Set<string>()
  private readonly errored = new Map<string, string>()

  /** Paced loader queue: enqueue returns a promise that resolves when done. */
  private queue: Promise<void> = Promise.resolve()

  /** Background warmup already scheduled for this activation. */
  private warmStarted = false
  /** Delay (ms) between background warmup loads — the "slowly progress" pace. */
  private warmGapMs = 40

  /** Listeners notified when a collection's item paths changed (new items added). */
  private readonly itemListeners = new Set<(collectionPath: string) => void>()

  /** Human-readable status message (rendered under the tree). */
  status = '加载中…'

  /** The library's root path (a top-level directory). */
  private rootPath = ''

  /** True once the collection hierarchy has been (re)loaded this session. */
  private treeReady = false

  /** The library root's virtual path. */
  getRootPath(): string {
    return this.rootPath
  }

  /** Every known collection directory descriptor (in registry order). */
  collectionNodes(): ZoteroNodeDescriptor[] {
    const out: ZoteroNodeDescriptor[] = []
    for (const node of this.nodes.values()) {
      if (node.kind === 'collection') out.push(node)
    }
    return out
  }

  /** Load the full collection hierarchy (cache-first, then /library.tree). */
  async loadLibrary(): Promise<void> {
    if (this.treeReady) return
    const cached = safeRead(TREE_KEY) as string | null
    const parsed = safeParse<ZoteroLibraryTreeResult | null>(cached, null)
    if (parsed !== null && Array.isArray(parsed.nodes)) {
      this.ingestLibrary(parsed)
      this.treeReady = true
      return
    }
    try {
      const result = await zoteroApi.libraryTree()
      this.ingestLibrary(result)
      this.treeReady = true
      safeWrite(TREE_KEY, JSON.stringify(result))
      this.status = '就绪'
    } catch (error) {
      this.status = `加载失败: ${errorMessage(error)}`
      throw error
    }
  }

  /** Ingest the library feed into the node map. */
  private ingestLibrary(result: ZoteroLibraryTreeResult): void {
    this.rootPath = result.rootPath
    for (const node of result.nodes) {
      this.nodes.set(node.path, node)
    }
  }

  /**
   * Ensure a collection's items are (been) loaded. Returns the item paths that
   * are currently present (they appear incrementally as the paced loader fills
   * them in). Async — never blocks the main render.
   */
  async ensureItems(collectionPath: string): Promise<string[]> {
    const cachedItems = safeRead(ITEMS_KEY_PREFIX + encodeURIComponent(collectionPath)) as string | null
    if (cachedItems !== null) {
      const itemPaths = safeParse<string[]>(cachedItems, [])
      this.applyItemPaths(collectionPath, itemPaths)
    }
    // Kick the paced load only once per collection; already-loaded ones no-op.
    if (!this.loaded.has(collectionPath) && !this.loading.has(collectionPath)) {
      this.loading.add(collectionPath)
      this.enqueue(() => this.loadCollection(collectionPath))
    }
    return this.itemsByCollection.get(collectionPath) ?? []
  }

  /** The paced single-flight worker for one collection's item load. */
  private async loadCollection(collectionPath: string): Promise<void> {
    // First page synchronously-ish (still async), so the tree fills fast.
    try {
      const descs = await zoteroApi.expand(collectionPath)
      const paths = descs.map((d) => d.path)
      for (const d of descs) this.nodes.set(d.path, d)
      this.applyItemPaths(collectionPath, paths)
      this.loaded.add(collectionPath)
      this.notifyItems(collectionPath)
      // Persist the full item list (bounded size).
      if (paths.length > 0 && paths.join(',').length < ITEM_CACHE_BYTES) {
        safeWrite(ITEMS_KEY_PREFIX + encodeURIComponent(collectionPath), JSON.stringify(paths))
      }
    } catch (error) {
      this.errored.set(collectionPath, errorMessage(error))
      this.status = `部分集合加载失败: ${errorMessage(error)}`
    } finally {
      this.loading.delete(collectionPath)
    }
  }

  /** Register item paths for a collection (dedupe, preserve order). */
  private applyItemPaths(collectionPath: string, paths: string[]): void {
    const existing = this.itemsByCollection.get(collectionPath) ?? []
    const seen = new Set(existing)
    const next = existing.slice()
    for (const p of paths) {
      if (!seen.has(p)) {
        seen.add(p)
        next.push(p)
      }
    }
    this.itemsByCollection.set(collectionPath, next)
  }

  /** Item paths currently present for a collection. */
  itemPaths(collectionPath: string): string[] {
    return this.itemsByCollection.get(collectionPath) ?? []
  }

  /** Look up a node descriptor by path. */
  get(path: string): ZoteroNodeDescriptor | undefined {
    return this.nodes.get(path)
  }

  /** Whether a collection has loaded all its items (no pending pace). */
  isLoaded(path: string): boolean {
    return this.loaded.has(path)
  }

  /**
   * Subscribe to item-path additions. Called with the collection path each
   * time its item set grows (click-load or background warmup), so the tree
   * can add the new leaf rows. Returns the unsubscribe.
   */
  subscribeItems(listener: (collectionPath: string) => void): () => void {
    this.itemListeners.add(listener)
    return () => { this.itemListeners.delete(listener) }
  }

  /** Notify listeners that a collection gained new item paths. */
  private notifyItems(collectionPath: string): void {
    for (const fn of this.itemListeners) fn(collectionPath)
  }

  /**
   * Kick off the background warmup: after the library is loaded, traverse
   * every collection in a paced serial loop and pre-load its items (cached
   * in localStorage). User click-loads share the same single-flight queue and
   * interrupt seamlessly. No-op if already started or the library isn't ready.
   */
  warmAll(): void {
    if (this.warmStarted || !this.treeReady) return
    this.warmStarted = true
    const collections = this.collectionNodes()
    void (async () => {
      for (const node of collections) {
        void this.ensureItems(node.path)
        await delay(this.warmGapMs)
      }
      this.status = `就绪（已暖机 ${this.loaded.size}/${collections.length} 个集合）`
    })()
  }

  /** A stable error for a path, if the load failed. */
  errorOf(path: string): string | undefined {
    return this.errored.get(path)
  }

  /** Run `fn` after every previously enqueued task (serial, paced). */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn, fn)
  }
}

/** A user-facing message from an unknown error. */
export function errorMessage(error: unknown): string {
  if (error instanceof ZoteroApiError) return `[${error.code}] ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

/** `setTimeout` in promise form (the warmup pacing helper). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

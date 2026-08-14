/**
 * Shared wire types between the host half (zotero-cli) and the client half
 * (the sidebar tree). Keep lossless JSON only — no live objects cross this
 * boundary.
 */

/** A Zotero collection as returned by `zotero-cli --json collection tree`. */
export interface ZoteroCollectionNode {
  collectionID: number
  key: string
  collectionName: string
  parentCollectionID: number | null
  libraryID: number
  version: number
  itemCount: number
  /** Child collections (recursive). */
  children?: ZoteroCollectionNode[]
}

/** A Zotero item as returned by `zotero-cli --json collection items <key>`. */
export interface ZoteroItem {
  itemID: number
  key: string
  libraryID: number
  itemTypeID: number
  typeName: string
  dateAdded: string
  dateModified: string
  version: number
  title: string
  noteParentItemID: number | null
  noteContent: string | null
  attachmentParentItemID: number | null
  annotationParentItemID: number | null
  annotationText: string | null
  annotationComment: string | null
  linkMode: number | null
  contentType: string | null
  attachmentPath: string | null
  fields: Record<string, unknown>
  creators: unknown[]
  tags: unknown[]
  isAttachment: boolean
  isNote: boolean
  isAnnotation: boolean
  parentItemID: number | null
  noteText: string
  notePreview: string
}

/** A Zotero node the sidebar shows, as the host feeds it to the tree. */
export interface ZoteroNodeDescriptor {
  /** Stable unique path in the tree (also the node identity). */
  path: string
  /** Display name. */
  name: string
  /** 'collection' for a directory, 'item' / 'attachment' / 'note' for a leaf. */
  kind: 'collection' | 'item' | 'attachment' | 'note'
  /** Zotero item key (collections carry their own key, items theirs). */
  key: string
  /** Parent collection key (for item -> collection back-reference). */
  collectionKey?: string
  /** True when a collection has child collections or items to lazy-load. */
  hasChildren: boolean
}

/** The first-level tree feed: root + the eagerly-rendered depth-1/2 nodes. */
export interface ZoteroLibraryTreeResult {
  rootPath: string
  rootName: string
  /** Collection descriptors for the first two levels (eager render). */
  nodes: ZoteroNodeDescriptor[]
}

/** Body envelope used across /zotero/api/* (mirror of the standard wire). */
export type ZoteroOk<T> = { ok: true; value: T }
export type ZoteroErr = { ok: false; error: { code: string; message: string } }

/** A searchable/summary slice of a Zotero item (for the & search popup + resolve tool). */
export interface ZoteroItemSummary {
  key: string
  title: string
  typeName: string
  /** Creator names (best-effort joined). */
  creatorsLabel: string
  /** Publication year, when available. */
  year?: string
  /** Conference / journal / publication name, when available. */
  venue?: string
  /** First ~200 chars of abstract (for search display), when present. */
  abstractPreview?: string
}

/** One item search result. */
export interface ZoteroSearchResult extends ZoteroItemSummary {
  /** The collection path (tree identity) the item sits under, when resolvable. */
  path?: string
}

/** Result of a Zotero item search. */
export interface ZoteroSearchResponse {
  query: string
  results: ZoteroSearchResult[]
}

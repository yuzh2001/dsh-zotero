/**
 * The Zotero sidebar tree. Mounts a vanilla @pierre/trees FileTree inside a
 * React lifecycle and drives it from the ZoteroStore:
 *
 * - the full collection hierarchy is fed up front; every collection path ends
 *   with `/`, so each collection renders as an expandable directory right
 *   away (even before its items load);
 * - on directory expansion, the collection's items load asynchronously and
 *   paced (never blocking the main thread), cached in localStorage by the
 *   store;
 * - a small status bar reports load progress / errors.
 */
import { useEffect, useRef, useState } from 'react'
import { FileTree } from '@pierre/trees'
import type { FileTreeDirectoryHandle, ContextMenuItem, ContextMenuOpenContext, FileTreeDropResult } from '@pierre/trees'
import { ZoteroStore } from './store.js'
import { appendZoteroChip } from './reference.js'
import type { Context } from '../context-types.js'
import type { JSX } from 'react'

interface ZoteroTreeProps {
  store: ZoteroStore
  /** The session-scoped cordis context (to insert composer references). */
  ctx?: Context
  /** The active session id (for composer reference insertion). */
  sessionId?: string
}

export function ZoteroTree({ store, ctx, sessionId }: ZoteroTreeProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState(store.status)

  useEffect(() => {
    const mount = mountRef.current
    if (mount === null) return

    let disposed = false
    let tree: FileTree | undefined
    let ft: FileTree | undefined // scoped ref so closures see the mounted tree
    let unsubscribe = (): void => {}
    let offItems = (): void => {}
    let referencePath: (path: string) => void = () => {}
    /** Whether a drag was consumed inside the tree (vs released onto the chatbox). */
    let dropHandled = false
    /** The path of the row currently being dragged (set on dragstart). */
    let dragPath = ''

    const onStatus = (): void => {
      if (!disposed) setStatus(store.status)
    }

    /** Double-click a row -> @-reference it (reads data-item-path from DOM). */
    const onDblClick = (event: MouseEvent): void => {
      // The tree renders inside a shadow root; `event.target` is retargeted to
      // the host, so walk `composedPath()` to find the inner row button.
      const hit = event.composedPath?.().find((el): el is Element =>
        el instanceof Element && el.matches('button[data-item-path]'))
      if (hit === undefined) return
      const path = (hit as HTMLElement).dataset.itemPath
      if (path !== undefined) referencePath(path)
    }
    mount.addEventListener('dblclick', onDblClick)

    /** Record the row path when a drag starts (reads data-item-path from DOM). */
    const onDragStart = (event: DragEvent): void => {
      const hit = event.composedPath?.().find((el): el is Element =>
        el instanceof Element && el.matches('button[data-item-path]'))
      dragPath = (hit as HTMLElement | undefined)?.dataset.itemPath ?? ''
      dropHandled = false
    }
    /** A drop landed inside the tree (handled by @pierre/trees' onDropComplete). */
    const onDrop = (event: DragEvent): void => {
      dropHandled = true
    }
    /** Drag released: if not dropped internally, treat it as "drop onto the
     *  composer" and insert the row's @reference (the chatbox itself doesn't
     *  accept external plain-text drops, so we can't rely on the target). */
    const onDragEnd = (event: DragEvent): void => {
      if (dropHandled || dragPath === '') return
      referencePath(dragPath)
      dragPath = ''
    }
    mount.addEventListener('dragstart', onDragStart)
    mount.addEventListener('drop', onDrop)
    mount.addEventListener('dragend', onDragEnd)

    /**
     * Add one path to the tree only if it is not already present. pierre/trees
     * PathStore.add is NOT idempotent: re-adding an existing path throws
     * "Path already exists". Background warmup and on-expand loads can race, so
     * this guard is what keeps the tree stable under concurrent loads.
     */
    // DIAGNOSTIC (temporary): trace the last adds to locate the stack-overflow trigger.
    const diag = (globalThis as { __addtrace?: Array<{ l: number; p: string }> }).__addtrace ??= []
    const safeAdd = (p: string): void => {
      if (disposed || ft === undefined) return
      diag.push({ l: p.length, p })
      if (diag.length > 300) diag.shift()
      try {
        const already = ft.getItem(p) !== null
        if (!already) ft.add(p)
      } catch (err) {
        const m = (err as Error)?.message ?? String(err)
        if (/Maximum call stack|call stack/.test(m)) {
          ;(globalThis as unknown as { __addtraceLastPath?: string }).__addtraceLastPath = p
        }
        throw err
      }
    }

    /** Add every currently-known item path of a collection to the tree. */
    const addItems = (collectionPath: string): void => {
      if (disposed || ft === undefined) return
      for (const p of store.itemPaths(collectionPath)) safeAdd(p)
    }

    void (async () => {
      try {
        await store.loadLibrary()
        if (disposed) return
        onStatus()

        // Feed every collection directory path (trailing `/`) plus the root.
        const paths: string[] = [store.getRootPath()]
        for (const node of store.collectionNodes()) paths.push(node.path)

        /** Insert an @-reference for one tree path into the composer. */
        referencePath = (path: string): void => {
          if (disposed) return
          const node = store.get(path)
          if (node === undefined) return
          if (!(ctx && sessionId)) { console.warn('[dsa-zotero-sidebar] no session scope for @-reference'); return }
          appendZoteroChip(ctx, sessionId, node.key, node.name)
        }

        ft = new FileTree({
          paths,
          initialExpansion: 'open',
          search: true,
          dragAndDrop: {
            canDrag: () => true,
            onDropComplete: (event: FileTreeDropResult) => {
              dropHandled = true
              // An internal drop into a folder is not a reference; the
              // dragEnd path only inserts when the drop was NOT handled here.
              void event
            },
          },
          composition: {
            contextMenu: {
              enabled: true,
              triggerMode: 'right-click',
              render: (item: ContextMenuItem, context: ContextMenuOpenContext): HTMLElement => {
                // @pierre/trees only draws a menu when `render` returns a
                // non-null element. The returned root MUST be marked
                // `data-file-tree-context-menu-root` so @pierre/trees treats
                // clicks inside it as inside the menu (not outside-click
                // close).
                const menu = document.createElement('div')
                menu.setAttribute('data-file-tree-context-menu-root', 'true')
                menu.style.cssText = 'position:fixed;z-index:2147483002;min-width:160px;background:var(--vscode-menu-background,#252526);color:var(--vscode-menu-foreground,#ccc);border:1px solid var(--vscode-menu-border,#454545);border-radius:6px;padding:4px;font:13px/1.6 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.28);'
                const rect = context.anchorRect
                if (rect) {
                  menu.style.left = `${rect.left}px`
                  menu.style.top = `${rect.bottom + 4}px`
                } else {
                  menu.style.left = '50%'
                  menu.style.top = '50%'
                  menu.style.transform = 'translate(-50%,-50%)'
                }
                const row = document.createElement('button')
                row.type = 'button'
                row.textContent = '插入 @引用到对话'
                row.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:none;color:inherit;padding:6px 8px;border-radius:4px;cursor:pointer;font:inherit;'
                // Prevent the mousedown from stealing focus / being seen as an
                // outside click; the click then lands on the button.
                row.addEventListener('mousedown', (e) => e.preventDefault())
                row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground,rgba(90,93,94,.3))' })
                row.addEventListener('mouseleave', () => { row.style.background = 'none' })
                row.addEventListener('click', (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  context.close()
                  referencePath(item.path)
                })
                menu.appendChild(row)
                return menu
              },
              onOpen: () => {
                // The menu renders via `render`; nothing else needed here.
              },
            },
          },
        })
        tree = ft
        ft.render({ containerWrapper: mount })

        // Background warmup: slowly pre-load every collection's items.
        store.warmAll()

        // When warmup/click-load grows a collection's item set, add the rows.
        offItems = store.subscribeItems((collectionPath) => {
          addItems(collectionPath)
          onStatus()
        })

        // On any tree change, immediately load items for collections that the
        // user just expanded (they won't wait for the background warmup pace).
        unsubscribe = ft.subscribe(() => {
          if (disposed || ft === undefined) return
          for (const node of store.collectionNodes()) {
            if (store.isLoaded(node.path)) continue
            const item = ft.getItem(node.path)
            if (item === null || item.isDirectory() === false) continue
            const dir = item as FileTreeDirectoryHandle
            if (!dir.isExpanded()) continue
            addItems(node.path)
            void store.ensureItems(node.path).then((itemPaths) => {
              if (disposed || ft === undefined) return
              for (const p of itemPaths) safeAdd(p)
              onStatus()
            })
          }
        })

        onStatus()
      } catch {
        onStatus()
      }
    })()

    return () => {
      disposed = true
      unsubscribe()
      offItems()
      mount.removeEventListener('dblclick', onDblClick)
      mount.removeEventListener('dragstart', onDragStart)
      mount.removeEventListener('drop', onDrop)
      mount.removeEventListener('dragend', onDragEnd)
      tree?.cleanUp()
      tree = undefined
      ft = undefined
    }
    // `store` is stable for the component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
      <div
        style={{
          padding: '4px 10px',
          fontSize: '11px',
          lineHeight: 1.4,
          color: 'var(--vscode-descriptionForeground, #8b8b8b)',
          borderTop: '1px solid var(--vscode-panel-border, #2a2d2e)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
        }}
      >
        {status}
      </div>
    </div>
  )
}

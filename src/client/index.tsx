/**
 * Client half of dsa-zotero-sidebar:
 * - registers a "Zotero" tab with the better-sidebar service
 *   (`ctx.betterSidebar.registerTab`) whose component renders the
 *   @pierre/trees Zotero tree (browsing + @-references on dbl-click / drag /
 *   right-click);
 * - mounts a global root that listens for `&` in the main composer and shows
 *   the Zotero search overlay.
 * The features degrade gracefully when their backing services are absent.
 */
import { createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, ReactNode } from 'react'
import type { Context } from '../context-types.js'
import { ZoteroTree } from './ZoteroTree.js'
import { ZoteroStore } from './store.js'
import { AmpRoot } from './AmpRoot.js'
import { openAmp } from './amp-trigger.js'

/** Services required before mounting (better-sidebar + slots + sessions + input-trigger). */
export const inject = ['betterSidebar', 'slots', 'sessions', 'inputTriggers']

/** The props the sidebar's tab shell passes to each tab component. */
interface ZoteroTabProps {
  ctx?: Context
  scope?: { sessionId: string; cwd?: string }
}

/** A tiny folder icon shown in the + menu. */
function FolderGlyph(): JSX.Element {
  return createElement(
    'svg',
    { viewBox: '0 0 16 16', width: '14', height: '14', 'aria-hidden': true as never },
    createElement('path', {
      fill: 'currentColor',
      d: 'M1.75 3h4.13l1.5 1.5h6.87a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H1.75a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    }),
  )
}

/** The tab component: owns a ZoteroStore and renders the tree, threading the
 *  session scope (ctx + sessionId) so the tree can @-reference into the composer. */
function ZoteroTab(props: ZoteroTabProps): JSX.Element {
  const storeRef = useRef<ZoteroStore | null>(null)
  if (storeRef.current === null) storeRef.current = new ZoteroStore()
  const sessionId = props.scope?.sessionId ?? ''
  return createElement(ZoteroTree, { store: storeRef.current, ctx: props.ctx, sessionId })
}

/** Resolve the current (active) session id from the sessions list, if any. */
function currentSessionId(ctx: Context): string {
  try {
    const list = ctx.sessions?.list?.getSnapshot()
    if (typeof list?.current === 'string') return list.current
    // eslint-disable-next-line no-console
    console.warn('[dsa-zotero-sidebar][amp] no current session; list=', list)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[dsa-zotero-sidebar][amp] sessions.list read failed:', error)
  }
  return ''
}

/** Client plugin body. */
export function apply(ctx: Context): void {
  // ── Sidebar tab (browse tree + @-references) ────────────────────────────
  ctx.effect(() => {
    const bs = ctx.betterSidebar
    if (bs === undefined) return () => {} // better-sidebar absent: no-op disposer
    return bs.registerTab({
      id: 'dsa-zotero:library',
      title: () => 'Zotero',
      icon: createElement(FolderGlyph) as unknown as ReactNode,
      order: 20,
      single: true,
      component: (props: unknown) => createElement(ZoteroTab, props as ZoteroTabProps),
    })
  }, 'dsa-zotero-sidebar: register zotero tab')

  // ── Slash-command `/zotero`: opens the SAME Zotero search overlay the `&`
  //    trigger shows (search + select + insert `《title》{%ZoteroItem:key}`).
  //    Picking `/zotero` returns `'handled'` so DSH takes no text action; we
  //    simply pop the shared overlay, whose pick/close also clears `/zotero`. ──
  ctx.effect(() => {
    const it = ctx.inputTriggers
    if (it === undefined) return () => {}
    const source = {
      trigger: '/' as const,
      name: 'zotero',
      order: 20,
      candidates: async (): Promise<Array<{ name: string; description?: string }>> => {
        return [{
          name: 'zotero',
          description: '搜索 Zotero 文献并引用（打开搜索弹窗）',
        }]
      },
      onPick: (): unknown => {
        openAmp('/zotero')
        return 'handled'
      },
      matchEnter: (): unknown => {
        openAmp('/zotero')
        return 'handled'
      },
    }
    const disposer = it.registerSource(source)
    return () => disposer()
  }, 'dsa-zotero-sidebar: register /zotero slash source')

  // ── Global overlays: the `&` Zotero search overlay ─────────────────────
  ctx.effect(() => {
    let root: Root | undefined
    let host: HTMLDivElement | undefined
    try {
      // No chip styling needed: references are inserted as plain text
      // (`[title]{%ZoteroItem:key}`), not DSH chips.
      host = document.createElement('div')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482999;'
      document.body.appendChild(host)
      root = createRoot(host)
      root.render(createElement(
        'div',
        null,
        createElement(AmpRoot, {
          ctx,
          getSessionId: () => currentSessionId(ctx),
        }),
      ))
    } catch (error) {
      console.warn('[dsa-zotero-sidebar] overlay mount failed:', error)
    }
    return () => {
      root?.unmount()
      host?.remove()
    }
  }, 'dsa-zotero-sidebar: global overlays')
}

/**
 * The Zotero `&` search overlay. A self-drawn floating panel (no official
 * input-trigger package — the frozen trigger pipeline only supports `/` and
 * `@`). While open it OWNS the query (assembled from keystrokes), debounced
 * searches the library via `/zotero/api/search`, navigates with ArrowUp/Down,
 * confirmed with Enter → inserts a `@@<key>` chip, dismissed with Escape.
 */
import { useEffect, useRef, useState } from 'react'
import { zoteroApi } from './zotero-api.js'
import { appendZoteroReference, cancelAmpSearch } from './reference.js'
import { currentSession } from './session-cache.js'
import type { Context } from '../context-types.js'
import type { ZoteroSearchResult } from '../shared.js'
import type { JSX } from 'react'

interface AmpOverlayProps {
  ctx?: Context
  sessionId?: string
  /** What opened this overlay: `&` (typed) or `/zotero` (slash command). */
  trigger?: string
  onClose: () => void
}

/** How long to wait before issuing a search after the query changes. */
const SEARCH_DEBOUNCE_MS = 180

export function ZoteroSearchOverlay({ ctx, sessionId, trigger, onClose }: AmpOverlayProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ZoteroSearchResult[]>([])
  const [pending, setPending] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The composer draft at the instant the overlay opened. Because the overlay
  // owns a real focused <input>, the composer tail is just the trigger (`&` or
  // `/zotero`) — on pick we drop it and append the token.
  const baseDraftRef = useRef<string>('')
  const readyRef = useRef(false)

  // Focus the search input and make sure it STARTS EMPTY (the trigger `&` /
  // `/zotero` must not leak into the query box). Keystrokes then go to the
  // search box and never to the composer textarea (no duplicated input).
  useEffect(() => {
    if (inputRef.current !== null) {
      if (inputRef.current.value !== '') { inputRef.current.value = ''; setQuery('') }
      inputRef.current.focus()
    }
  }, [])

  // Snapshot the composer draft once, when the overlay mounts.
  useEffect(() => {
    const sid = currentSession(sessionId ?? '')
    if (!ctx || !sid) return
    try {
      const actx = (ctx.sessions as unknown as { scope?(id: string): unknown }).scope?.(sid)
      const conversations = ctx.get?.('conversation') as unknown as {
        input: { for(a: unknown): { state: { getSnapshot(): { draft: string } } } }
      } | undefined
      if (actx !== undefined && conversations !== undefined) {
        const input = conversations.input.for(actx)
        baseDraftRef.current = input.state.getSnapshot().draft
        readyRef.current = true
      }
    } catch { /* ignore */ }
  }, [ctx, sessionId])

  const pick = (item: ZoteroSearchResult): void => {
    const sid = currentSession(sessionId ?? '')
    if (ctx && sid) {
      // Replace the captured pre-trigger draft (minus the trigger token) with the
      // reference, so neither `&`/`/zotero` nor any query text leaks into the input.
      let base = baseDraftRef.current
      base = trigger === '/zotero'
        // Slash trigger may be partial (`/zo`, `/zotero`) — strip any `/`+
        // zotero-prefixed token the user typed to fire the command.
        ? base.replace(/\/z\w*\s*$/, '')
        : base.replace(/&\s*$/, '')
      appendZoteroReference(ctx, sid, item.key, item.title, readyRef.current
        ? { baseDraft: base, stripTrailingAmp: false }
        : undefined)
    }
    onClose()
  }

  // Debounced search on query change.
  useEffect(() => {
    const q = query.trim()
    if (q === '') { setResults([]); return }
    setPending(true)
    const ctrl = new AbortController()
    const t = window.setTimeout(() => {
      void zoteroApi.search(q, 20, ctrl.signal)
        .then((resp) => { setResults(resp.results); setHighlight(0) })
        .catch(() => { /* cancelled / failed */ })
        .finally(() => setPending(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(t); ctrl.abort() }
  }, [query])

  // Search-box keyboard handling (runs on the real <input>, so it owns keys).
  const onInputKeyDown = (event: import('react').KeyboardEvent<HTMLInputElement>): void => {
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      // Restore the composer to the pre-trigger draft (drop `&` or `/zotero`).
      if (readyRef.current) {
        const sid = currentSession(sessionId ?? '')
        if (ctx && sid) cancelAmpSearch(ctx, sid, baseDraftRef.current, trigger === '/zotero' ? '/zotero' : '&')
      }
      onClose(); return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = results[highlight]
      if (item !== undefined) pick(item)
      return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((h) => Math.min(h + 1, Math.max(results.length - 1, 0))); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); return }
  }

  // Inject the breathing underline + caret styles for the search query (keyed
  // so HMR never leaks duplicates; removed on unmount).
  useEffect(() => {
    const tagId = 'dsa-zotero-amp-css'
    if (document.getElementById(tagId) !== null) return
    const style = document.createElement('style')
    style.id = tagId
    style.textContent = [
      '.dsa-zotero-amp-query {',
      '  border-bottom: 2px solid transparent;',
      '  border-image: linear-gradient(90deg,#3b82f6,#93c5fd) 1;',
      '  border-bottom-style: solid;',
      '  animation: dsaAmpBreath 3s ease-in-out infinite;',
      '}',
      '@keyframes dsaAmpBreath { 0%,100% { opacity: .72; } 50% { opacity: 1; } }',
    ].join('\n')
    document.head.appendChild(style)
    return () => { const el = document.getElementById(tagId); if (el !== null) el.remove() }
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '8px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(520px, 90vw)',
        maxHeight: '320px',
        overflow: 'auto',
        zIndex: 2147483000,
        background: 'var(--vscode-editor-background, #ffffff)',
        color: 'var(--vscode-foreground, #1f1f1f)',
        border: '1px solid var(--vscode-panel-border, #ccc)',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0,0,0,.18)',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        padding: '6px',
        pointerEvents: 'auto',
      }}
    >
      <div style={{ padding: '4px 10px 6px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ opacity: .75, fontWeight: 600 }}>@@</span>
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          <span style={{ opacity: .42 }}>Zotero 引用搜索</span>
        </span>
      </div>
      <input
        ref={inputRef}
        className="dsa-zotero-amp-query"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder="搜索 Zotero 文献…"
        autoFocus
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '2px 10px 8px',
          fontSize: '15px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'var(--vscode-foreground,#1f1f1f)',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          display: 'block',
        }}
      />
      {pending && <div style={{ padding: '6px 10px', opacity: .6 }}>搜索中…</div>}
      {!pending && results.length === 0 && (
        <div style={{ padding: '6px 10px', opacity: .6 }}>
          {query.trim() ? '没有匹配的 Zotero 文档' : '输入关键词开始搜索'}
        </div>
      )}
      <ul ref={listRef} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {results.map((item, i) => (
          <li
            key={item.key}
            style={{
              padding: '6px 8px',
              borderRadius: '4px',
              cursor: 'pointer',
              background: i === highlight ? 'var(--vscode-list-activeSelectionBackground, rgba(0,120,215,.15))' : 'transparent',
            }}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => pick(item)}
            title={item.path ?? item.key}
          >
            <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.title}
            </div>
            <div style={{ opacity: .7, fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {[item.creatorsLabel, item.year].filter(Boolean).join(' · ') || item.typeName}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

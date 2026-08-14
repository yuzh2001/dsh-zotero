/**
 * Zotero reference insertion into the composer as PLAIN TEXT.
 *
 * No chip, no U+FFFC occurrence, no backdrop mutation. We inject a real, human-
 * readable token `[论文标题]{%ZoteroItem:key}` via the scoped plain-text insert
 * event (`slash/input-insert-text`). Because it is ordinary text, the caret
 * stays perfectly aligned and DSH renders it exactly as typed — nothing about
 * the composer's React/backdrop is touched.
 *
 * Both entry points (dbl-click in the sidebar tree and a `&` search pick) call
 * the same `appendZoteroReference`, so the model always sees the same
 * self-describing form:
 *   [MADRL-based DSO-customer ...]{%ZoteroItem:ZNB79RWH}
 */
import type { Context } from '../context-types.js'
import { rememberSession } from './session-cache.js'

/** Prefix for the human-readable title segment (书名号). */
export const ZOTERO_TITLE_OPEN = '《'
export const ZOTERO_TITLE_CLOSE = '》'
/** Model-readable machine token wrapping the item key. */
export const ZOTERO_ITEM_OPEN = '{%ZoteroItem:'
export const ZOTERO_ITEM_CLOSE = '%}'

/** Regex matching a full reference token in a draft, capturing title + key. */
export const ZOTERO_REF_RE = /《([^》]*)》\{%ZoteroItem:([\w-]+)%\}/g

/** Build the full reference token: `《title》{%ZoteroItem:key}`. */
export function zoteroRefToken(title: string, key: string): string {
  // Guard: strip any `》` from the title so the bracket stays well-formed.
  const safeTitle = title.replace(/》/g, '')
  return `${ZOTERO_TITLE_OPEN}${safeTitle}${ZOTERO_TITLE_CLOSE}${ZOTERO_ITEM_OPEN}${key}${ZOTERO_ITEM_CLOSE}`
}

/** Extract `key` from a `《..》{%ZoteroItem:key}` token, or `null` if not one. */
export function keyFromToken(token: string): string | null {
  const m = /^《[^》]*》\{%ZoteroItem:([\w-]+)%\}$/.exec(token)
  const key = m?.[1]
  return key === undefined ? null : key
}

/** Whether a string contains any Zotero reference token. */
export function containsZoteroToken(text: string): boolean {
  ZOTERO_REF_RE.lastIndex = 0
  return ZOTERO_REF_RE.test(text)
}

/**
 * Zotero desktop deep-link. `zotero://select/items/1_<key>` focuses the item
 * in the Zotero desktop app (the `1_` prefix is the library id for the user's
 * default library; this scheme works for the standard local library).
 */
export function zoteroSelectUrl(key: string): string {
  return `zotero://select/items/1_${key}`
}

/** Options controlling where/how the reference is spliced in. */
export interface AppendRefOptions {
  /**
   * The full draft observed at the moment the `&` overlay opened. When set, the
   * reference replaces this whole buffer (after dropping a trailing `&` trigger)
   * instead of appending to the live tail — this is what lets the `&` overlay
   * scrub the trigger character and any query text out of the composer.
   */
  baseDraft?: string
  /** If true (default) and baseDraft ends in `&`, that trigger char is dropped. */
  stripTrailingAmp?: boolean
}

/**
 * Append a Zotero reference as plain text at the end of the draft.
 *
 * Injects `《title》{%ZoteroItem:key}` through the scoped `slash/input-insert-text`
 * event (DSH's plain-text path — no occurrence, no placeholder). When `opts.baseDraft`
 * is supplied, the LIVE tail is replaced by `baseDraft` (with the trailing `&`
 * stripped) plus the token, so the `&` overlay can clean up the trigger and any
 * search text. Falls back to `setDraft` if the scoped event is unavailable.
 * Returns false and logs when the composer/session cannot be reached.
 */
export function appendZoteroReference(ctx: Context, sessionId: string, key: string, title: string, opts?: AppendRefOptions): boolean {
  try {
    const sessions = ctx.sessions as unknown as {
      scope?(id: string): {
        emit?(event: string, req: unknown): boolean | undefined | void
        bail?(subject: unknown, event: string, req: unknown): unknown
      } | undefined
    }
    const actx = sessions.scope?.(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get?.('conversation') as unknown as {
      input: {
        for(a: unknown): {
          state: { getSnapshot(): { draft: string; draftRev: number } }
          setDraft?(t: string): void
        }
      }
    } | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const snap = input.state.getSnapshot()
    const token = zoteroRefToken(title || key, key)

    // Decide the insertion point. If the `&` overlay captured a base draft, we
    // splice there (stripping a trailing `&`); otherwise append to the live tail.
    let insertText: string
    let spanStart: number
    let spanRevision: number
    if (opts?.baseDraft !== undefined) {
      let base = opts.baseDraft
      if (opts.stripTrailingAmp !== false) {
        const trimmed = base.replace(/&+\s*$/, '')
        if (trimmed !== base) base = trimmed
      }
      const gap = base === '' || /[\s]$/.test(base) ? '' : ' '
      insertText = base + gap + token
      spanStart = base.length
      spanRevision = snap.draftRev // live draft still equals baseDraft post-overlay
    } else {
      const gap = snap.draft === '' || /[\s]$/.test(snap.draft) ? '' : ' '
      insertText = gap + token
      spanStart = snap.draft.length
      spanRevision = snap.draftRev
    }
    const span = { start: spanStart, end: spanStart, draftRev: spanRevision }

    if (opts?.baseDraft !== undefined) {
      // Whole-buffer replacement is best done directly through setDraft.
      if (typeof (input as { setDraft?: unknown }).setDraft === 'function') {
        ;(input as { setDraft(t: string): void }).setDraft(insertText)
        rememberSession(sessionId)
        return true
      }
    }
    // Plain-text insert through the scoped event (DSH's own `execute` uses `bail`).
    if (typeof actx.bail === 'function') {
      const handled = actx.bail(actx, 'slash/input-insert-text', { text: token, span })
      if (handled === true) { rememberSession(sessionId); return true }
      console.warn('[dsa-zotero-sidebar] slash/input-insert-text not handled; falling back to setDraft')
    } else if (typeof actx.emit === 'function') {
      const handled = actx.emit('slash/input-insert-text', { text: token, span })
      if (handled === true) { rememberSession(sessionId); return true }
      console.warn('[dsa-zotero-sidebar] slash/input-insert-text emit not handled; falling back to setDraft')
    }
    // Fallback: append via the input action face / setDraft.
    const tail = snap.draft.trim() === '' ? token : ` ${token}`
    if (typeof (input as { setDraft?: unknown }).setDraft === 'function') {
      ;(input as { setDraft(t: string): void }).setDraft(snap.draft + tail)
      rememberSession(sessionId)
      return true
    }
    console.warn('[dsa-zotero-sidebar] composer insert unavailable (no scoped event, no setDraft)')
    return false
  } catch (error) {
    console.warn('[dsa-zotero-sidebar] composer reference insert failed:', error)
    return false
  }
}

/**
 * Cancel an active search overlay: restore the composer to its pre-trigger draft,
 * dropping the trailing trigger (`&` or `/zotero`). Used on Escape so a cancelled
 * search leaves no trigger text behind.
 */
export function cancelAmpSearch(ctx: Context, sessionId: string, baseDraft: string, trigger?: string): boolean {
  try {
    const actx = (ctx.sessions as unknown as { scope?(id: string): unknown }).scope?.(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get?.('conversation') as unknown as {
      input: { for(a: unknown): { setDraft?(t: string): void; state: { getSnapshot(): { draftRev: number } } } }
    } | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const restored = trigger === '/zotero'
      ? baseDraft.replace(/\/z\w*\s*$/, '')
      : baseDraft.replace(/&+\s*$/, '')
    if (typeof (input as { setDraft?: unknown }).setDraft === 'function') {
      ;(input as { setDraft(t: string): void }).setDraft(restored)
      rememberSession(sessionId)
      return true
    }
    return false
  } catch (error) {
    console.warn('[dsa-zotero-sidebar] cancelAmpSearch failed:', error)
    return false
  }
}

// Backward-compatible alias (kept so existing call sites don't need renames; it
// returns void the same way the old function did).
export function appendZoteroChip(ctx: Context, sessionId: string, key: string, title: string): boolean {
  return appendZoteroReference(ctx, sessionId, key, title)
}

/**
 * The global root for the `&` Zotero search overlay. Mounted once from the
 * plugin entry; not tied to the sidebar tab, so it fires whenever the user
 * types `&` in the main composer.
 */
import { createElement } from 'react'
import type { JSX } from 'react'
import { useAmpOpen } from './amp-trigger.js'
import { ZoteroSearchOverlay } from './ZoteroSearchOverlay.js'
import type { Context } from '../context-types.js'

interface AmpRootProps {
  ctx: Context
  /** The active session id (falls back to the first available). */
  getSessionId: () => string
}

export function AmpRoot({ ctx, getSessionId }: AmpRootProps): JSX.Element {
  const { open, trigger, close } = useAmpOpen()
  if (!open) return createElement('div', { 'data-dsa-zotero-amp-root': true })
  const sessionId = getSessionId()
  return createElement(
    'div',
    { 'data-dsa-zotero-amp-root': true },
    createElement(ZoteroSearchOverlay, { ctx, sessionId, trigger, onClose: close }),
  )
}

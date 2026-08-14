/**
 * The `&` trigger — opens the Zotero search overlay when `&` is typed in the
 * composer. Also exposes a module-level `openAmp(trigger)` so the `/zotero`
 * slash source can open the SAME overlay (shared search-and-insert UI).
 *
 * All overlay interaction (query assembly, navigation, pick, close) lives in the
 * overlay component so there is a single owner of the in-open key handling.
 * IME-guarded: while a native composition runs, `&` never opens the overlay.
 */
import { useCallback, useEffect, useState } from 'react'

/** Whether the current focus target is a text-editing element (composer). */
function isEditingTarget(): boolean {
  const el = document.activeElement
  if (el === null) return false
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return false
}

/** The current overlay control (registered while `&`/`/zotero` is armed). */
let ampControl: { open(trigger: string): void; close(): void } | null = null

/** Register the overlay control; returns an unregister disposer. */
export function registerAmpControl(ctl: { open(trigger: string): void; close(): void }): () => void {
  ampControl = ctl
  return () => { if (ampControl === ctl) ampControl = null }
}

/** Open the shared Zotero search overlay (used by the `/zotero` slash source). */
export function openAmp(trigger: string): void {
  ampControl?.open(trigger)
}

/** Close the shared overlay if open. */
export function closeAmp(): void {
  ampControl?.close()
}

export function useAmpOpen(): { open: boolean; trigger: string; close: () => void } {
  const [open, setOpen] = useState(false)
  const [trigger, setTrigger] = useState('&')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key !== '&') return
      if (!isEditingTarget()) return
      // Do NOT preventDefault: let the `&` land in the composer draft so it is
      // visibly typed. We only open the overlay.
      setTrigger('&')
      setOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // Expose the external open/close entrance (the `/zotero` slash source).
  useEffect(() => {
    return registerAmpControl({
      open(nextTrigger): void { setTrigger(nextTrigger); setOpen(true) },
      close(): void { setOpen(false) },
    })
  }, [])

  const close = useCallback(() => setOpen(false), [])
  return { open, trigger, close }
}

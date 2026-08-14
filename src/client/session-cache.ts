/**
 * A tiny module-level cache of the last-known active Zotero session id.
 *
 * The `&` search overlay is global (not inside a sidebar tab), and the client
 * plugin's root context may not expose `ctx.sessions.list` reliably. The
 * sidebar tab always has a valid sessionId (from the tab props); each time it
 * inserts a chip it records that session here, giving the global `&` overlay a
 * reliable fallback for where to insert the picked reference.
 */

let lastSessionId = ''

/** Record a session id that provably worked (called on successful chip insert). */
export function rememberSession(sessionId: string): void {
  if (sessionId !== '' && sessionId !== lastSessionId) lastSessionId = sessionId
}

/** The last known-good session id, or an explicit fallback. */
export function currentSession(sessionId: string): string {
  return sessionId !== '' ? sessionId : lastSessionId
}

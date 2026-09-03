/**
 * Shared external-link policy for the main process.
 *
 * Transcript markdown renders bare `<a href>` anchors, so a left-click is a
 * same-window `will-navigate` — not a popup — and the old
 * `setWindowOpenHandler`-only guard let it replace the ADE. These pure
 * helpers back both the `will-navigate`/`will-redirect` safety net and the
 * `shell.openUrl` RPC, so all three agree on what may leave the window.
 */

/** Schemes the OS browser may be asked to open. Everything else is denied. */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Internal navigations that must stay inside the window. */
const APP_PROTOCOLS = new Set(['about:', 'devtools:', 'chrome-devtools:'])

/** True when the URL is safe to hand to `shell.openExternal`. */
export function isExternalOpenable(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol)
}

/**
 * True when the URL is the app itself: the packaged `file://` renderer, the
 * Vite dev-server origin, or an internal `about:`/`devtools:` navigation.
 * Everything else must never become a top-level document navigation.
 */
export function isAppUrl(rawUrl: string, devServerUrl?: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (APP_PROTOCOLS.has(parsed.protocol)) return true
  if (parsed.protocol === 'file:') return true
  if (parsed.protocol === 'data:') return true
  if (devServerUrl) {
    try {
      if (parsed.origin === new URL(devServerUrl).origin) return true
    } catch {
      return false
    }
  }
  return false
}

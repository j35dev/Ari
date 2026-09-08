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
 * True when the URL is the app itself: the packaged renderer's entry file,
 * the Vite dev-server origin, or an internal `about:`/`devtools:`
 * navigation. Everything else must never become a top-level document
 * navigation — notably arbitrary `file:` URLs (local file read rendered in
 * the app window) and `data:` URLs (attacker HTML running in the app
 * context with IPC access) are never the app.
 */
export function isAppUrl(
  rawUrl: string,
  devServerUrl?: string,
  appFileUrl?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (APP_PROTOCOLS.has(parsed.protocol)) return true
  if (parsed.protocol === 'file:') {
    if (!appFileUrl) return false
    let entry: URL
    try {
      entry = new URL(appFileUrl)
    } catch {
      return false
    }
    if (entry.protocol !== 'file:' || parsed.host !== entry.host) return false
    // Same entry file: SPA hash routes (`index.html#/settings`) stay.
    const pathname = (url: URL): string =>
      platform === 'win32' ? url.pathname.toLowerCase() : url.pathname
    return pathname(parsed) === pathname(entry)
  }
  if (devServerUrl) {
    try {
      if (parsed.origin === new URL(devServerUrl).origin) return true
    } catch {
      return false
    }
  }
  return false
}

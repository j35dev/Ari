import { createLogger } from '@ari/shared/logger'
import { rpc } from './rpc'
import { LOCAL_HTML_PREFIX } from '../features/transcript/markdown'
import { LOCAL_MEDIA_PREFIX } from '../../../shared/local-media'

const log = createLogger('desktop:external-links')

/** Anchor hrefs that leave the ADE for the OS browser. */
export function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')
}

/** Local anchors and downloads stay on their default path. */
function isBypassed(anchor: HTMLAnchorElement, href: string): boolean {
  if (anchor.hasAttribute('download')) return true
  // data:/blob: payloads must never navigate the ADE window top-level —
  // they are attacker-controllable content, so they fall through to the
  // block below instead of their default navigation path.
  return href.startsWith('#') || href.startsWith('about:')
}

/** Fired on `window` when a clicked link could not be opened; `detail` says why. */
export const LINK_FAILED_EVENT = 'ari:link-failed'

/** Main validates the path and hands it to the OS file association. */
async function openLocalFile(
  anchor: HTMLAnchorElement,
  href: string,
  prefix: typeof LOCAL_HTML_PREFIX | typeof LOCAL_MEDIA_PREFIX,
): Promise<void> {
  try {
    const path = decodeURIComponent(href.slice(prefix.length))
    if (prefix === LOCAL_MEDIA_PREFIX) {
      const result = await rpc.invoke('shell.openMediaFile', { path })
      if (!result.opened) throw new Error(result.reason)
    } else {
      const sessionId = anchor.closest('[data-session]')?.getAttribute('data-session')
      await rpc.invoke('shell.openHtmlFile', { path, ...(sessionId ? { sessionId } : {}) })
    }
  } catch (error) {
    const reason =
      error instanceof URIError
        ? 'This file link is invalid.'
        : error instanceof Error
          ? error.message
          : String(error)
    log.warn('open local file failed', { error: reason })
    window.dispatchEvent(new CustomEvent(LINK_FAILED_EVENT, { detail: reason }))
  }
}

function openExternal(href: string): void {
  rpc.invoke('shell.openUrl', { url: href }).catch((error: unknown) => {
    log.warn('open external link failed', { error: String(error) })
  })
}

function intercept(event: Event): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return
  const href = anchor.getAttribute('href') ?? ''
  const localPrefix = ([LOCAL_HTML_PREFIX, LOCAL_MEDIA_PREFIX] as const).find((prefix) =>
    href.startsWith(prefix),
  )
  if (localPrefix) {
    event.preventDefault()
    void openLocalFile(anchor, href, localPrefix)
    return
  }
  if (href.length === 0 || isBypassed(anchor, href)) return
  // External links open in the OS browser; anything else (custom schemes
  // from agent output) is blocked so it can never navigate the ADE window.
  event.preventDefault()
  if (isExternalHref(href)) openExternal(href)
}

/**
 * Global delegated handler so every surface rendering agent markdown
 * (transcript, tool results, approvals) opens links in the associated OS app
 * instead of navigating the ADE window. Covers left-click plus
 * middle-click / Ctrl+click via `auxclick`.
 */
export function installExternalLinkInterceptor(): () => void {
  document.addEventListener('click', intercept)
  document.addEventListener('auxclick', intercept)
  return () => {
    document.removeEventListener('click', intercept)
    document.removeEventListener('auxclick', intercept)
  }
}

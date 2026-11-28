import { createLogger } from '@ari/shared/logger'
import { rpc } from './rpc'
import { LOCAL_FILE_PREFIX } from '../../../shared/local-file-link'

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

async function openLocalFile(anchor: HTMLAnchorElement, href: string): Promise<void> {
  try {
    if (anchor.closest('[data-remote-workspace]'))
      throw new Error('This link points to a file or folder on another machine.')
    const path = decodeURIComponent(href.slice(LOCAL_FILE_PREFIX.length))
    const sessionId =
      anchor.closest('[data-file-link-session]')?.getAttribute('data-file-link-session') ??
      anchor.closest('[data-session]')?.getAttribute('data-session')
    const result = await rpc.invoke('shell.openLocalFile', {
      path,
      ...(sessionId ? { sessionId } : {}),
    })
    if (!result.opened) throw new Error(result.reason)
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
  if (href.startsWith(LOCAL_FILE_PREFIX)) {
    event.preventDefault()
    if (
      event.isTrusted &&
      event instanceof MouseEvent &&
      event.button === (event.type === 'click' ? 0 : 1)
    )
      void openLocalFile(anchor, href)
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

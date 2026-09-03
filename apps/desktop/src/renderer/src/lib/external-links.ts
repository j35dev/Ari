import { createLogger } from '@ari/shared/logger'
import { rpc } from './rpc'

const log = createLogger('desktop:external-links')

/** Anchor hrefs that leave the ADE for the OS browser. */
export function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')
}

/** Local anchors, downloads, and blob/data payloads stay on their default path. */
function isBypassed(anchor: HTMLAnchorElement, href: string): boolean {
  if (anchor.hasAttribute('download')) return true
  return (
    href.startsWith('#') ||
    href.startsWith('blob:') ||
    href.startsWith('data:') ||
    href.startsWith('about:')
  )
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
  if (href.length === 0 || isBypassed(anchor, href)) return
  // External links open in the OS browser; anything else (custom schemes
  // from agent output) is blocked so it can never navigate the ADE window.
  event.preventDefault()
  if (isExternalHref(href)) openExternal(href)
}

/**
 * Global delegated handler so every surface rendering agent markdown
 * (transcript, tool results, approvals) opens links in the OS browser
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

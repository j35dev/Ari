/**
 * What the in-app browser may load. http(s) only, plus about:blank as the
 * empty tab. file:/javascript:/data: never reach the guest — those belong
 * outside this view, or nowhere.
 */

const NAVIGABLE = new Set(['http:', 'https:'])

/** True when a fully-resolved URL may become the guest's document. */
export function isBrowserNavigable(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') return true
  try {
    const parsed = new URL(rawUrl)
    return NAVIGABLE.has(parsed.protocol)
  } catch {
    return false
  }
}

function isLoopbackHost(value: string): boolean {
  const host = value.split('/')[0]?.split(':')[0]?.toLowerCase() ?? ''
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * Turns an address-bar string into a loadable URL. Bare hosts get https,
 * except loopback which stays http so local dev servers work.
 */
export function resolveBrowserUrl(
  input: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'about:blank') {
    return { ok: true, url: 'about:blank' }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (!NAVIGABLE.has(parsed.protocol)) {
        return { ok: false, error: `${parsed.protocol} URLs cannot open in the in-app browser` }
      }
      return { ok: true, url: parsed.href }
    } catch {
      return { ok: false, error: 'Enter an http(s) URL' }
    }
  }
  const candidate = `${isLoopbackHost(trimmed) ? 'http' : 'https'}://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (!NAVIGABLE.has(parsed.protocol) || parsed.hostname.length === 0) {
      return { ok: false, error: 'Enter an http(s) URL' }
    }
    return { ok: true, url: parsed.href }
  } catch {
    return { ok: false, error: 'Enter an http(s) URL' }
  }
}

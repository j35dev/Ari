import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installExternalLinkInterceptor, isExternalHref } from './external-links'

describe('isExternalHref', () => {
  it('matches http, https, and mailto only', () => {
    expect(isExternalHref('http://localhost:3000')).toBe(true)
    expect(isExternalHref('https://example.com')).toBe(true)
    expect(isExternalHref('mailto:hi@example.com')).toBe(true)
    expect(isExternalHref('file:///x')).toBe(false)
    expect(isExternalHref('#section')).toBe(false)
    expect(isExternalHref('blob:abc')).toBe(false)
  })
})

describe('installExternalLinkInterceptor', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ opened: true })
    window.ari = {
      invoke,
      subscribe: () => () => undefined,
    }
    document.body.innerHTML = ''
  })

  it('routes external clicks to shell.openUrl and blocks navigation', () => {
    const cleanup = installExternalLinkInterceptor()
    try {
      document.body.innerHTML = '<a href="http://localhost:3000">app</a>'
      const anchor = document.querySelector('a')
      if (!anchor) throw new Error('missing fixture anchor')
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(invoke).toHaveBeenCalledWith('shell.openUrl', { url: 'http://localhost:3000' })
    } finally {
      cleanup()
    }
  })

  it('leaves downloads and in-page anchors on their default path', () => {
    const cleanup = installExternalLinkInterceptor()
    try {
      document.body.innerHTML =
        '<a href="blob:abc" download="report.csv">dl</a><a href="#s">jump</a>'
      for (const anchor of document.querySelectorAll('a')) {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true })
        anchor.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
      }
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })
})

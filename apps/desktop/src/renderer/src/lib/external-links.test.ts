import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installExternalLinkInterceptor, isExternalHref, LINK_FAILED_EVENT } from './external-links'
import { renderMarkdown } from '../features/transcript/markdown'

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

  it('blocks data: and blob: payload links instead of navigating', () => {
    const cleanup = installExternalLinkInterceptor()
    try {
      document.body.innerHTML =
        '<a href="data:text/html,<script>alert(1)</script>">evil</a><a href="blob:abc">payload</a>'
      for (const anchor of document.querySelectorAll('a')) {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true })
        anchor.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
      }
      expect(invoke).not.toHaveBeenCalled()
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

describe('HTML file links in a conversation', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ opened: true })
    window.ari = { invoke, subscribe: () => () => undefined }
    document.body.innerHTML = ''
  })

  function click(): MouseEvent {
    const anchor = document.querySelector('a')
    if (!anchor) throw new Error('missing fixture anchor')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    return event
  }

  it('asks main to open the file, naming the session it was written in', () => {
    const cleanup = installExternalLinkInterceptor()
    try {
      document.body.innerHTML = `<div data-session="sess_1">${renderMarkdown('[report](out/report.html#totals)')}</div>`
      const event = click()
      expect(event.defaultPrevented).toBe(true)
      expect(invoke).toHaveBeenCalledWith('shell.openHtmlFile', {
        path: 'out/report.html#totals',
        sessionId: 'sess_1',
      })
    } finally {
      cleanup()
    }
  })

  it('says why when the file could not be opened', async () => {
    invoke.mockRejectedValue(new Error('No file at /work/out/report.html'))
    const reasons: unknown[] = []
    const listen = (event: Event): void => {
      reasons.push((event as CustomEvent).detail)
    }
    window.addEventListener(LINK_FAILED_EVENT, listen)
    const cleanup = installExternalLinkInterceptor()
    try {
      document.body.innerHTML = renderMarkdown('[report](out/report.html)')
      click()
      await vi.waitFor(() => expect(reasons).toEqual(['No file at /work/out/report.html']))
      // No session around the link: main is told only the path.
      expect(invoke).toHaveBeenCalledWith('shell.openHtmlFile', { path: 'out/report.html' })
    } finally {
      cleanup()
      window.removeEventListener(LINK_FAILED_EVENT, listen)
    }
  })
})

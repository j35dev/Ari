import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('file and folder clicks in a conversation', () => {
  const invoke = vi.fn()
  const failed = vi.fn()
  let cleanup: () => void
  let delegatedClick: EventListener | undefined

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ opened: true })
    failed.mockReset()
    window.ari = { invoke, subscribe: () => () => undefined }
    document.body.innerHTML = ''
    window.addEventListener(LINK_FAILED_EVENT, failed)
    const listen = vi.spyOn(document, 'addEventListener')
    cleanup = installExternalLinkInterceptor()
    const listener = listen.mock.calls.find(([name]) => name === 'click')?.[1]
    delegatedClick = typeof listener === 'function' ? listener : undefined
    listen.mockRestore()
  })

  afterEach(() => {
    cleanup()
    window.removeEventListener(LINK_FAILED_EVENT, failed)
  })

  function click(trusted: boolean): void {
    const anchor = document.querySelector('a')
    if (!anchor || !delegatedClick) throw new Error('missing click fixture')
    if (!trusted) {
      anchor.click()
      return
    }
    // Only a browser input event can set isTrusted on a real event.
    const event = Object.create(MouseEvent.prototype) as MouseEvent
    for (const [key, value] of Object.entries({
      type: 'click',
      button: 0,
      target: anchor,
      isTrusted: true,
      preventDefault: vi.fn(),
    }))
      Object.defineProperty(event, key, { value })
    delegatedClick(event)
  }

  it('passes the local session and encoded file path only on a trusted click', () => {
    document.body.innerHTML =
      '<div data-file-link-session="sess_local">' +
      renderMarkdown('[Read](<reports/Project Brief%231.pdf>)') +
      '</div>'
    click(false)
    expect(invoke).not.toHaveBeenCalled()
    click(true)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('shell.openLocalFile', {
      sessionId: 'sess_local',
      path: 'reports/Project%20Brief%231.pdf',
    })
  })

  it.each(['<C:/Demos/Brief.pdf>', './reports/'])(
    'keeps remote workspace paths on their host (%s)',
    (target) => {
      document.body.innerHTML =
        '<div data-file-link-session="sess_remote" data-remote-workspace>' +
        renderMarkdown('[Open](' + target + ')') +
        '</div>'
      click(true)
      expect(invoke).not.toHaveBeenCalled()
      expect(failed.mock.calls[0]?.[0]).toMatchObject({
        detail: expect.stringContaining('another machine'),
      })
    },
  )

  it('reports a failed native action', async () => {
    const reason = 'The file or folder could not be found or accessed.'
    invoke.mockResolvedValue({ opened: false, reason })
    document.body.innerHTML = renderMarkdown('[Open](C:/Demos/Brief.pdf)')
    click(true)
    await vi.waitFor(() => expect(failed.mock.calls[0]?.[0]).toMatchObject({ detail: reason }))
  })
})

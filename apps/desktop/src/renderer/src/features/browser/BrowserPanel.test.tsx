import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerOverlay } from '@ari/ui/overlay-registry'
import { BrowserPanel } from './BrowserPanel'

const STILL = 'data:image/jpeg;base64,cGFnZQ=='

const { invokeFn, subscribeFn } = vi.hoisted(() => ({
  invokeFn: vi.fn(),
  subscribeFn: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: subscribeFn,
  },
}))

describe('BrowserPanel', () => {
  beforeEach(() => {
    invokeFn.mockReset()
    subscribeFn.mockReset()
    subscribeFn.mockReturnValue(() => undefined)
    invokeFn.mockImplementation(async (method: string) => {
      if (method === 'browser.open') {
        return {
          id: 'inspector',
          url: 'about:blank',
          title: '',
          canGoBack: false,
          canGoForward: false,
          loading: false,
          error: null,
        }
      }
      if (method === 'browser.navigate') return { ok: true, tab: { id: 'inspector' } }
      if (method === 'browser.go') return { id: 'inspector' }
      if (method === 'browser.layout') return { applied: true }
      if (method === 'browser.cancelPick') return { cancelled: true }
      if (method === 'browser.pick') return { ok: false, error: 'cancelled' }
      if (method === 'browser.capture') return { dataUrl: STILL }
      if (method === 'shell.openUrl') return { opened: true }
      throw new Error(`unexpected method: ${method}`)
    })
  })

  it('opens a guest tab and navigates from the address bar', async () => {
    const user = userEvent.setup()
    render(<BrowserPanel />)

    expect(await screen.findByLabelText('Address')).toBeInTheDocument()
    expect(screen.getByLabelText('Pick element for agent')).toBeDisabled()
    expect(invokeFn).toHaveBeenCalledWith('browser.open', { id: 'inspector' })

    await user.type(screen.getByLabelText('Address'), 'example.com')
    await user.keyboard('{Enter}')
    expect(invokeFn).toHaveBeenCalledWith('browser.navigate', {
      id: 'inspector',
      url: 'example.com',
    })
  })

  it('hides the guest when the panel unmounts', () => {
    const { unmount } = render(<BrowserPanel />)
    unmount()
    expect(invokeFn).toHaveBeenCalledWith(
      'browser.layout',
      expect.objectContaining({ id: 'inspector', visible: false }),
    )
  })

  describe('with a page loaded', () => {
    const layouts = (): boolean[] =>
      invokeFn.mock.calls
        .filter(([method]) => method === 'browser.layout')
        .map(([, params]) => (params as { visible: boolean }).visible)

    beforeEach(() => {
      const blank = invokeFn.getMockImplementation()
      invokeFn.mockImplementation(async (method: string) => {
        const result: unknown = await blank?.(method)
        return method === 'browser.open'
          ? { ...(result as object), url: 'https://example.com/' }
          : result
      })
      // jsdom lays nothing out: give every element a box and paint a dialog over all of it.
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 400,
        bottom: 600,
        width: 400,
        height: 600,
      } as DOMRect)
      document.elementFromPoint = () => document.querySelector('[role="dialog"]')
    })

    afterEach(() => {
      vi.restoreAllMocks()
      document.querySelector('[role="dialog"]')?.remove()
    })

    it('keeps a still under the guest and hides the guest the moment an overlay covers it', async () => {
      const { container } = render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
      await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', STILL))

      const release = registerOverlay(document.createElement('div'))
      await Promise.resolve()
      expect(layouts().at(-1)).toBe(false)

      release()
      await Promise.resolve()
      expect(layouts().at(-1)).toBe(true)
    })

    it('ignores an overlay that sits clear of the page', async () => {
      render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
      const menu = document.createElement('div')
      menu.getBoundingClientRect = () =>
        ({ left: 500, top: 0, right: 700, bottom: 100, width: 200, height: 100 }) as DOMRect
      const release = registerOverlay(menu)
      await Promise.resolve()
      expect(layouts().at(-1)).toBe(true)
      release()
    })

    it('still hides the guest for unregistered app UI the hit-test sweep finds', async () => {
      render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))

      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      await waitFor(() => expect(layouts().at(-1)).toBe(false))

      dialog.remove()
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
    })

    it('moves the toast stack clear of the page while it shows', async () => {
      const { unmount } = render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
      const inset = (): string =>
        document.documentElement.style.getPropertyValue('--ari-native-inset-right')
      expect(inset()).toBe(`${window.innerWidth}px`)
      // A menu standing the page down for a moment must not shuffle the toasts.
      const release = registerOverlay(document.createElement('div'))
      await Promise.resolve()
      expect(layouts().at(-1)).toBe(false)
      expect(inset()).toBe(`${window.innerWidth}px`)
      release()
      unmount()
      expect(inset()).toBe('')
    })

    it('hides the guest while its host has no box, as under a hidden workspace', async () => {
      render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
      document.elementFromPoint = () => null
      const none = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(none as DOMRect)
      window.dispatchEvent(new Event('resize'))
      await waitFor(() => expect(layouts().at(-1)).toBe(false))

      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        ...none,
        right: 400,
        bottom: 600,
        width: 400,
        height: 600,
      } as DOMRect)
      window.dispatchEvent(new Event('resize'))
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
    })
  })
})

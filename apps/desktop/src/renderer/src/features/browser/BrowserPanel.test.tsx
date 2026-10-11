import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from './BrowserPanel'

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
      if (method === 'browser.capture') return { pngBase64: 'cGFnZQ==' }
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

    it('swaps the guest for a still while app UI covers it', async () => {
      const { container } = render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))

      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      const still = await waitFor(() => {
        const img = container.querySelector('img')
        expect(img).toHaveAttribute('src', 'data:image/png;base64,cGFnZQ==')
        return img as HTMLImageElement
      })
      // The guest stays up until its stand-in has loaded.
      expect(layouts().at(-1)).toBe(true)
      fireEvent.load(still)
      await waitFor(() => expect(layouts().at(-1)).toBe(false))

      dialog.remove()
      await waitFor(() => expect(layouts().at(-1)).toBe(true))
      expect(container.querySelector('img')).toBeNull()
    })

    it('hides the guest outright when no still can be captured', async () => {
      const loaded = invokeFn.getMockImplementation()
      invokeFn.mockImplementation(async (method: string) => {
        const result: unknown = await loaded?.(method)
        return method === 'browser.capture' ? { pngBase64: null } : result
      })
      const { container } = render(<BrowserPanel />)
      await waitFor(() => expect(layouts().at(-1)).toBe(true))

      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.append(dialog)
      await waitFor(() => expect(layouts().at(-1)).toBe(false))
      expect(container.querySelector('img')).toBeNull()
    })
  })
})

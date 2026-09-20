import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})

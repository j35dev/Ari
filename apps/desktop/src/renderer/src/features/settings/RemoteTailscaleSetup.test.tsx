import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TailscaleState } from '@ari/contracts/rpc'
import { RemoteTailscaleSetup } from './RemoteTailscaleSetup'

const origin = 'https://workstation.tailnet.ts.net:8443'
function state(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return {
    installed: true,
    dnsName: 'workstation.tailnet.ts.net',
    origin,
    serving: false,
    owned: true,
    httpsPort: 8443,
    target: 'http://127.0.0.1:8787',
    targetListening: false,
    conflicts: [],
    suggestedHttpsPort: 8444,
    error: null,
    ...overrides,
  }
}

describe('Tailscale mapping recovery', () => {
  it.each([false, null])(
    'repairs an owned unavailable root with listener status %s on its saved port',
    async (targetListening) => {
      const enable = vi.fn()
      render(
        <RemoteTailscaleSetup
          state={state({ targetListening })}
          enabled
          disabled={false}
          enable={enable}
          disable={vi.fn()}
          refresh={vi.fn()}
        />,
      )
      await userEvent.click(screen.getByRole('button', { name: 'Repair Ari connection' }))
      expect(enable).toHaveBeenCalledExactlyOnceWith()
    },
  )

  it('preserves the saved port when its root is missing beside another mount', async () => {
    const enable = vi.fn()
    const sibling = {
      origin,
      httpsPort: 8443,
      mountPath: '/docs',
      target: '/shared/docs',
      kind: 'path' as const,
      listening: null,
    }
    render(
      <RemoteTailscaleSetup
        state={state({ conflicts: [sibling] })}
        enabled
        disabled={false}
        enable={enable}
        disable={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Repair Ari connection' }))
    expect(enable).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByRole('button', { name: /Review replacement/ })).not.toBeInTheDocument()
  })

  it('removes an owned stale mapping while remote access is off', async () => {
    const disable = vi.fn()
    render(
      <RemoteTailscaleSetup
        state={state()}
        enabled={false}
        disabled={false}
        enable={vi.fn()}
        disable={disable}
        refresh={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Repair Ari connection' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Ari mapping' }))
    expect(disable).toHaveBeenCalledOnce()
  })

  it('changes an owned address only when the user explicitly chooses the new port', async () => {
    const enable = vi.fn()
    render(
      <RemoteTailscaleSetup
        state={state()}
        enabled
        disabled={false}
        enable={enable}
        disable={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Use new address on port 8444' }))
    expect(enable).toHaveBeenCalledExactlyOnceWith({ httpsPort: 8444 })
  })

  it('uses a free alternate port for a foreign root and leaves it unchanged on request', async () => {
    const enable = vi.fn()
    const foreign = {
      origin: 'https://workstation.tailnet.ts.net',
      httpsPort: 443,
      mountPath: '/',
      target: 'http://127.0.0.1:3000',
      kind: 'proxy' as const,
      listening: true,
    }
    render(
      <RemoteTailscaleSetup
        state={state({ owned: false, conflicts: [foreign], suggestedHttpsPort: 8443 })}
        enabled
        disabled={false}
        enable={enable}
        disable={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Leave unchanged' }))
    expect(enable).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Existing services are unchanged')
    await userEvent.click(screen.getByRole('button', { name: 'Use port 8443' }))
    expect(enable).toHaveBeenCalledExactlyOnceWith({ httpsPort: 8443 })
  })

  it('requires confirmation before sending the exact observed root for replacement', async () => {
    const enable = vi.fn()
    const foreign = {
      origin,
      httpsPort: 8443,
      mountPath: '/',
      target: '',
      kind: 'text' as const,
      listening: null,
    }
    render(
      <RemoteTailscaleSetup
        state={state({ owned: false, conflicts: [foreign], suggestedHttpsPort: null })}
        enabled
        disabled={false}
        enable={enable}
        disable={vi.fn()}
        refresh={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: `Review replacement at ${origin}` }))
    expect(enable).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm replacement' }))
    expect(enable).toHaveBeenCalledExactlyOnceWith({
      replace: { origin, mountPath: '/', target: '', kind: 'text' },
    })
  })
})

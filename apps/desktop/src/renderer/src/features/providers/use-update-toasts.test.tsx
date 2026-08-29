import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { useUpdateToasts } from './use-update-toasts'

const { invokeFn, subscribeFn } = vi.hoisted(() => ({
  invokeFn: vi.fn(),
  subscribeFn: vi.fn<(name: string, params: unknown, cb: (payload: unknown) => void) => () => void>(
    () => () => undefined,
  ),
}))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: subscribeFn,
  },
}))

function Watcher() {
  useUpdateToasts()
  return null
}

describe('useUpdateToasts', () => {
  beforeEach(() => {
    invokeFn.mockReset()
    subscribeFn.mockReset()
  })

  it('shows an Update toast and runs providers.install on click', async () => {
    let onFrame: ((payload: unknown) => void) | undefined
    subscribeFn.mockImplementation((_name: string, _params: unknown, cb: (payload: unknown) => void) => {
      onFrame = cb
      return () => undefined
    })
    invokeFn.mockResolvedValue({ started: true })
    render(
      <ToastProvider>
        <Watcher />
      </ToastProvider>,
    )
    expect(onFrame).toBeDefined()
    onFrame?.({
      type: 'detections',
      detections: [
        {
          kind: 'claude',
          installed: true,
          binaryPath: '/usr/bin/claude',
          version: '2.1.0',
          authStatus: 'authenticated',
          latestVersion: '2.2.0',
          updateAvailable: true,
        },
      ],
    })
    expect(await screen.findByText('Claude 2.2.0 available')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() =>
      expect(invokeFn).toHaveBeenCalledWith('providers.install', {
        kind: 'claude',
        operation: 'upgrade',
      }),
    )
    expect(screen.getByText('Updating Claude…')).toBeInTheDocument()

    onFrame?.({
      type: 'install.settled',
      kind: 'claude',
      operation: 'upgrade',
      ok: true,
      reason: null,
      truncated: false,
      version: '2.2.0 (Claude Code)',
    })
    expect(await screen.findByText('Claude is up to date')).toBeInTheDocument()
    expect(screen.getByText('2.2.0 (Claude Code)')).toBeInTheDocument()
  })
})

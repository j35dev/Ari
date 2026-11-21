import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { noteSetupDisplayed, setOnboardingShown } from '../onboarding/onboarding-presence'
import { AFTER_SETUP_QUIET_MS, useUpdateToasts } from './use-update-toasts'

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
    // As the gate does once it finds an established workspace.
    setOnboardingShown(false)
  })

  it('shows an Update toast and runs providers.install on click', async () => {
    let onFrame: ((payload: unknown) => void) | undefined
    subscribeFn.mockImplementation(
      (_name: string, _params: unknown, cb: (payload: unknown) => void) => {
        onFrame = cb
        return () => undefined
      },
    )
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
    expect(await screen.findByText('Claude updated')).toBeInTheDocument()
    expect(screen.getByText('2.2.0 (Claude Code)')).toBeInTheDocument()
  })

  it('reports phases and a retryable failure for an update started in Settings', async () => {
    let onFrame!: (payload: unknown) => void
    subscribeFn.mockImplementation((_name, _params, cb) => {
      onFrame = cb
      return () => undefined
    })
    invokeFn.mockResolvedValue({ started: true })
    render(
      <ToastProvider>
        <Watcher />
      </ToastProvider>,
    )
    act(() => onFrame({ type: 'install.started', kind: 'codex', operation: 'upgrade' }))
    expect(await screen.findByText('Updating Codex…')).toBeInTheDocument()
    act(() =>
      onFrame({
        type: 'install.phase',
        kind: 'codex',
        phase: 'waiting',
        message: 'Will update when the current turns finish.',
      }),
    )
    expect(screen.getByText('Will update when the current turns finish.')).toBeInTheDocument()
    act(() =>
      onFrame({
        type: 'install.settled',
        kind: 'codex',
        operation: 'upgrade',
        ok: false,
        reason: 'The CLI is still in use.',
        truncated: false,
      }),
    )
    expect(await screen.findByText('Could not update Codex')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(invokeFn).toHaveBeenCalledWith('providers.install', {
      kind: 'codex',
      operation: 'upgrade',
    })
    expect(screen.getByText('Updating Codex…')).toBeInTheDocument()
  })

  it('handles a rejected RPC request and lets Retry reconnect', async () => {
    let onFrame!: (payload: unknown) => void
    subscribeFn.mockImplementation((_name, _params, cb) => {
      onFrame = cb
      return () => undefined
    })
    invokeFn
      .mockRejectedValueOnce(new Error('IPC disconnected'))
      .mockResolvedValue({ started: true })
    render(
      <ToastProvider>
        <Watcher />
      </ToastProvider>,
    )
    act(() =>
      onFrame({
        type: 'detections',
        detections: [{ kind: 'codex', updateAvailable: true, latestVersion: '1.0.0' }],
      }),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }))
    expect(
      await screen.findByText('The update request failed. Retry to reconnect.'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(invokeFn).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Updating Codex…')).toBeInTheDocument()
  })

  it('holds announcements made before the gate has decided', () => {
    vi.resetModules()
    return import('../onboarding/onboarding-presence').then(({ isOnboardingShown }) =>
      expect(isOnboardingShown()).toBe(true),
    )
  })

  it('holds update toasts while setup is shown and shows them after', async () => {
    let onFrame!: (payload: unknown) => void
    subscribeFn.mockImplementation((_name, _params, cb) => {
      onFrame = cb
      return () => undefined
    })
    setOnboardingShown(true)
    try {
      render(
        <ToastProvider>
          <Watcher />
        </ToastProvider>,
      )
      act(() =>
        onFrame({
          type: 'detections',
          detections: [{ kind: 'codex', updateAvailable: true, latestVersion: '1.0.0' }],
        }),
      )
      // An install setup started reports on its own stage, never as a toast.
      act(() => {
        onFrame({ type: 'install.started', kind: 'claude', operation: 'install' })
        onFrame({
          type: 'install.phase',
          kind: 'claude',
          phase: 'downloading',
          message: 'Downloading Claude Code…',
        })
        onFrame({
          type: 'install.settled',
          kind: 'claude',
          operation: 'install',
          ok: true,
          reason: null,
          truncated: false,
        })
      })
      expect(screen.queryByText('Codex 1.0.0 available')).toBeNull()
      expect(screen.queryByText(/Installing Claude|Claude installed/)).toBeNull()
      act(() => setOnboardingShown(false))
      expect(await screen.findByText('Codex 1.0.0 available')).toBeInTheDocument()
      expect(screen.queryByText(/Claude installed/)).toBeNull()
    } finally {
      setOnboardingShown(false)
    }
  })

  // Last: marking setup as displayed is module state for the rest of the file.
  it('keeps the first minutes after a completed setup quiet, then announces', () => {
    vi.useFakeTimers()
    // The periodic detect finds nothing new; only the held frame should show.
    invokeFn.mockResolvedValue([])
    let onFrame!: (payload: unknown) => void
    subscribeFn.mockImplementation((_name, _params, cb) => {
      onFrame = cb
      return () => undefined
    })
    setOnboardingShown(true)
    noteSetupDisplayed()
    try {
      render(
        <ToastProvider>
          <Watcher />
        </ToastProvider>,
      )
      act(() =>
        onFrame({
          type: 'detections',
          detections: [{ kind: 'codex', updateAvailable: true, latestVersion: '1.0.0' }],
        }),
      )
      act(() => setOnboardingShown(false))
      // The landing session appears with no toast over it.
      expect(screen.queryByText('Codex 1.0.0 available')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(AFTER_SETUP_QUIET_MS - 1_000)
      })
      expect(screen.queryByText('Codex 1.0.0 available')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(screen.getByText('Codex 1.0.0 available')).toBeInTheDocument()
    } finally {
      setOnboardingShown(false)
      vi.useRealTimers()
    }
  })
})

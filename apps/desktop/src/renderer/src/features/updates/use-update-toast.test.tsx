import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { useAppUpdateToast } from './use-update-toast'

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
  useAppUpdateToast()
  return null
}

/** Captures the stream callback so a test can push frames. */
function captureStream(): { push: (frame: unknown) => void } {
  let onFrame: ((payload: unknown) => void) | undefined
  subscribeFn.mockImplementation(
    (_name: string, _params: unknown, cb: (payload: unknown) => void) => {
      onFrame = cb
      return () => undefined
    },
  )
  return { push: (frame) => onFrame?.(frame) }
}

function renderWatcher() {
  return render(
    <ToastProvider>
      <Watcher />
    </ToastProvider>,
  )
}

describe('useAppUpdateToast', () => {
  beforeEach(() => {
    invokeFn.mockReset()
    subscribeFn.mockReset()
  })

  it('offers the release with a sticky Update action and does not download yet', async () => {
    const stream = captureStream()
    invokeFn.mockResolvedValue({ started: true })
    renderWatcher()

    stream.push({ type: 'available', version: '0.4.0', currentVersion: '0.3.0' })

    expect(await screen.findByText('Ari 0.4.0 is available')).toBeInTheDocument()
    expect(screen.getByText("You're on 0.3.0.")).toBeInTheDocument()
    // Nothing moves until the user asks.
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it('walks offer → progress → restart, then installs on click', async () => {
    const stream = captureStream()
    invokeFn.mockResolvedValue({ started: true })
    renderWatcher()

    stream.push({ type: 'available', version: '0.4.0', currentVersion: '0.3.0' })
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }))
    await waitFor(() => expect(invokeFn).toHaveBeenCalledWith('app.update.download'))
    expect(await screen.findByText('Downloading Ari 0.4.0…')).toBeInTheDocument()

    stream.push({ type: 'download.progress', percent: 42 })
    expect(await screen.findByText('42%')).toBeInTheDocument()

    // Progress bursts redraw on whole percents only.
    stream.push({ type: 'download.progress', percent: 42 })
    stream.push({ type: 'download.progress', percent: 43 })
    expect(await screen.findByText('43%')).toBeInTheDocument()

    stream.push({ type: 'downloaded', version: '0.4.0' })
    expect(await screen.findByText('Ari 0.4.0 is ready')).toBeInTheDocument()
    expect(screen.getByText('Restart to finish installing.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(invokeFn).toHaveBeenCalledWith('app.update.install'))
  })

  it('announces a release staged in an earlier session exactly once', async () => {
    const stream = captureStream()
    invokeFn.mockResolvedValue({ started: true })
    renderWatcher()

    stream.push({ type: 'downloaded', version: '0.4.0' })
    expect(await screen.findByText('Ari 0.4.0 is ready')).toBeInTheDocument()

    // The stream replays current state on subscribe; a repeat must not stack.
    stream.push({ type: 'downloaded', version: '0.4.0' })
    stream.push({ type: 'available', version: '0.4.0', currentVersion: '0.3.0' })
    expect(screen.getAllByText('Ari 0.4.0 is ready')).toHaveLength(1)
  })

  it('stays quiet about a background check that failed', async () => {
    const stream = captureStream()
    renderWatcher()

    stream.push({ type: 'checking', manual: false })
    stream.push({ type: 'error', message: 'offline' })

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('explains a download that failed after the user clicked Update', async () => {
    const stream = captureStream()
    invokeFn.mockResolvedValue({ started: true })
    renderWatcher()

    stream.push({ type: 'available', version: '0.4.0', currentVersion: '0.3.0' })
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }))
    stream.push({ type: 'error', message: 'connection reset' })

    expect(await screen.findByText('Could not download the update')).toBeInTheDocument()
    expect(screen.getByText('connection reset')).toBeInTheDocument()
  })

  it('reports a download the main process refused', async () => {
    const stream = captureStream()
    invokeFn.mockResolvedValue({ started: false, reason: 'An update is already downloading.' })
    renderWatcher()

    stream.push({ type: 'available', version: '0.4.0', currentVersion: '0.3.0' })
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Could not download the update')).toBeInTheDocument()
    expect(screen.getByText('An update is already downloading.')).toBeInTheDocument()
  })
})

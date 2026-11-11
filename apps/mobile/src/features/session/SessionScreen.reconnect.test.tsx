// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://first.example/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from '../../lib/app-state'
import { MemoryDeviceStore } from '../../lib/device-key'
import { readDraft, readPending, writePending } from '../../lib/draft'
import { RemoteError } from '../../lib/gateway-client'
import type { ConnectionState } from '../../lib/session'
import { SessionScreen } from './SessionScreen'

interface Stream {
  dispose: ReturnType<typeof vi.fn>
  close: (code: number) => void
  frame: () => void
}
interface ControlledSession {
  state: ConnectionState
  capabilities: string[]
  change: (state: ConnectionState) => void
  connect: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<ConnectionState>>>
  query: ReturnType<typeof vi.fn<(op: string) => Promise<unknown>>>
  send: ReturnType<typeof vi.fn<(command: unknown, key?: string) => Promise<unknown>>>
  subscribe: ReturnType<typeof vi.fn>
  streams: Stream[]
}
const control = vi.hoisted(() => ({
  sessions: [] as ControlledSession[],
  result: vi.fn<(session: ControlledSession) => Promise<ConnectionState>>(),
}))
const snapshot = {
  session: {
    id: 'sess_1',
    projectId: 'proj_1',
    title: 'Reconnect',
    driverKind: 'codex',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  },
  summary: { id: 'sess_1', projectId: 'proj_1', title: 'Reconnect', status: 'idle', updatedAt: 1 },
  seq: 4,
  messages: [],
  pendingApprovals: [],
  pendingInputs: [],
}

// Only the transport/session boundary is controlled. The provider, screen and composer are real.
vi.mock('../../lib/session', () => ({
  MobileSession: class implements ControlledSession {
    state: ConnectionState = 'unpaired'
    capabilities = ['project.list', 'session.list', 'session.prompt', 'events.subscribe']
    deviceId = 'phone'
    streams: Stream[] = []
    constructor(private options: { onState: (state: ConnectionState) => void }) {
      control.sessions.push(this)
    }
    get usable(): boolean {
      return this.state === 'connected'
    }
    change(state: ConnectionState): void {
      this.state = state
      this.options.onState(state)
    }
    connect = vi.fn(async (_signal?: AbortSignal): Promise<ConnectionState> => {
      this.change('connecting')
      const state = await control.result(this)
      this.change(state)
      return state
    })
    supports(op: string): boolean {
      return this.capabilities.includes(op)
    }
    disconnect(): void {}
    query = vi.fn(async (op: string): Promise<unknown> => (op === 'session.get' ? snapshot : []))
    send = vi.fn<(command: unknown, key?: string) => Promise<unknown>>()
    subscribe = vi.fn(
      (
        _id: string,
        options: {
          onClose: (info: { code: number; reason: string }) => void
          onFrame: (frame: unknown) => void
        },
      ): (() => void) => {
        const stream = {
          dispose: vi.fn(),
          close: (code: number): void => {
            // MobileSession's actual order: notify AppProvider before forwarding the close.
            if (code === 1006) this.change('reconnecting')
            else if (code === 1008) this.change('revoked')
            options.onClose({ code, reason: '' })
          },
          frame: (): void => options.onFrame({ type: 'events.frame' }),
        }
        this.streams.push(stream)
        return stream.dispose
      },
    )
  },
}))

function View({ showSession = true }: { showSession?: boolean }) {
  const app = useApp()
  return (
    <>
      <p data-testid="connection">{app.connection}</p>
      <p data-testid="capabilities">{app.capabilities.join(',')}</p>
      <p data-testid="error">{app.error}</p>
      <button onClick={() => void app.reconnect()}>Reconnect</button>
      <button onClick={() => app.rememberOrigin('https://second.tailnet.ts.net')}>
        Select second computer
      </button>
      <button onClick={app.changeComputer}>Change computer</button>
      {showSession && app.booted && app.session !== null && (
        <SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />
      )}
    </>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const store = (): MemoryDeviceStore => new MemoryDeviceStore()
async function mount() {
  const deviceStore = store()
  const view = render(
    <AppProvider store={deviceStore} navigateTo={vi.fn()}>
      <View />
    </AppProvider>,
  )
  await waitFor(() => expect(control.sessions[0]?.subscribe).toHaveBeenCalledTimes(1))
  return { ...view, deviceStore, session: control.sessions[0]! }
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn()
  control.sessions = []
  control.result.mockReset().mockResolvedValue('connected')
  localStorage.setItem('ari.remote.origin', 'https://first.example')
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
  sessionStorage.clear()
})

describe('active-session reconnect ownership', () => {
  it('reconnects a drop without a foreground event and resubscribes once from the cursor', async () => {
    const { session } = await mount()
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    expect(screen.getByTestId('connection').textContent).toBe('reconnecting')
    expect(session.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    await advance(2100)
    expect(session.connect).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('connection').textContent).toBe('connected')
    expect(session.subscribe).toHaveBeenCalledTimes(2)
    expect(session.subscribe.mock.calls[1]).toEqual([
      'sess_1',
      expect.objectContaining({ fromSeq: 4 }),
    ])
    session.query.mockClear()
    act(() => session.streams[1]!.frame())
    await advance(700)
    expect(session.query).toHaveBeenCalledWith('session.get', { sessionId: 'sess_1' })
    await advance(30000)
    expect(session.subscribe).toHaveBeenCalledTimes(2)
  })

  it('stops after a failed connection cycle and permits manual recovery', async () => {
    const { session } = await mount()
    control.result.mockResolvedValueOnce('unreachable')
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    await advance(2100)
    expect(screen.getByTestId('connection').textContent).toBe('unreachable')
    expect(session.subscribe).toHaveBeenCalledTimes(1)
    await advance(120000)
    expect(session.connect).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await advance(0)
    expect(screen.getByTestId('connection').textContent).toBe('connected')
    expect(session.connect).toHaveBeenCalledTimes(3)
    expect(session.subscribe).toHaveBeenCalledTimes(2)
  })

  it('stops after an identity read throws before connecting, and reports manual recovery', async () => {
    const { session } = await mount()
    session.connect.mockRejectedValueOnce(new Error('Could not read this device identity.'))
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    await advance(2100)
    expect(screen.getByTestId('connection').textContent).toBe('unreachable')
    expect(screen.getByTestId('error').textContent).toBe('Could not read this device identity.')
    await advance(120000)
    expect(session.connect).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await advance(0)
    expect(screen.getByTestId('connection').textContent).toBe('connected')
    expect(screen.getByTestId('error').textContent).toBe('')
    expect(session.subscribe).toHaveBeenCalledTimes(2)
  })

  it.each(['online', 'manual', 'timer'] as const)(
    'coalesces %s, foreground and other reconnect requests',
    async (first) => {
      const { session } = await mount()
      const attempt = deferred<ConnectionState>()
      control.result.mockReturnValueOnce(attempt.promise)
      vi.useFakeTimers()
      act(() => session.streams[0]!.close(1006))
      if (first === 'timer') await advance(2000)
      else if (first === 'manual')
        fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      else
        act(() => {
          window.dispatchEvent(new Event('online'))
        })
      act(() => {
        window.dispatchEvent(new Event('online'))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      await advance(2100)
      expect(session.connect).toHaveBeenCalledTimes(2)
      await act(async () => attempt.resolve('connected'))
      expect(session.subscribe).toHaveBeenCalledTimes(2)
      await advance(30000)
      expect(session.connect).toHaveBeenCalledTimes(2)
      expect(session.subscribe).toHaveBeenCalledTimes(2)
    },
  )

  it('cancels a pending timer and closes the stream on provider unmount', async () => {
    const { session, unmount } = await mount()
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    unmount()
    await advance(120000)
    expect(session.connect).toHaveBeenCalledTimes(1)
    expect(session.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(session.connect).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight reconnect on unmount and ignores its late result', async () => {
    const { session, unmount } = await mount()
    const attempt = deferred<ConnectionState>()
    control.result.mockReturnValueOnce(attempt.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    unmount()
    expect(session.connect.mock.calls[1]?.[0]?.aborted).toBe(true)
    await act(async () => attempt.resolve('connected'))
    expect(session.subscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps the provider retry when the screen leaves, without reopening its stream', async () => {
    const { session, rerender, deviceStore } = await mount()
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    rerender(
      <AppProvider store={deviceStore} navigateTo={vi.fn()}>
        <View showSession={false} />
      </AppProvider>,
    )
    await advance(2100)
    expect(session.connect).toHaveBeenCalledTimes(2)
    expect(session.subscribe).toHaveBeenCalledTimes(1)
  })

  it('cancels the old computer timer when selecting another computer', async () => {
    const { session } = await mount()
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    fireEvent.click(screen.getByRole('button', { name: 'Select second computer' }))
    await advance(2100)
    expect(session.connect).toHaveBeenCalledTimes(1)
    expect(control.sessions[1]).toBeUndefined()
    expect(screen.getByTestId('connection').textContent).toBe('unpaired')
  })

  it('ignores old-computer authorization after selection changes, even if it ignores cancellation', async () => {
    const { session } = await mount()
    const attempt = deferred<ConnectionState>()
    control.result.mockReturnValueOnce(attempt.promise).mockResolvedValue('unknown-device')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select second computer' }))
    await waitFor(() => expect(screen.getByTestId('connection').textContent).toBe('unpaired'))
    await act(async () => attempt.resolve('connected'))
    expect(screen.getByTestId('connection').textContent).toBe('unpaired')
    expect(screen.getByTestId('capabilities').textContent).toBe('')
    expect(session.connect.mock.calls[1]?.[0]?.aborted).toBe(true)
    expect(session.subscribe).toHaveBeenCalledTimes(1)
  })

  it('ignores a late rejection after changing computer', async () => {
    await mount()
    const attempt = deferred<ConnectionState>()
    control.result.mockReturnValueOnce(attempt.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Change computer' }))
    await act(async () => attempt.reject(new Error('old computer failed')))
    expect(screen.getByTestId('connection').textContent).toBe('unpaired')
    expect(screen.getByTestId('error').textContent).toBe('')
  })

  it.each(['revoked', 'unknown-device', 'unpaired'] as const)(
    'does not retry a %s refusal',
    async (state) => {
      const { session } = await mount()
      control.result.mockResolvedValueOnce(state)
      vi.useFakeTimers()
      act(() => session.streams[0]!.close(1006))
      await advance(2100)
      expect(screen.getByTestId('connection').textContent).toBe(state)
      act(() => {
        window.dispatchEvent(new Event('online'))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      await advance(120000)
      expect(session.connect).toHaveBeenCalledTimes(2)
      expect(session.subscribe).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('capabilities').textContent).toBe('')
    },
  )

  it('stops automatic retries for a version mismatch and lets the user retry after an update', async () => {
    const { session } = await mount()
    control.result.mockResolvedValueOnce('version-mismatch')
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    await advance(2100)
    expect(screen.getByTestId('connection').textContent).toBe('version-mismatch')
    expect(screen.getByTestId('capabilities').textContent).toBe('')
    act(() => {
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(120000)
    expect(session.connect).toHaveBeenCalledTimes(2)
    expect(session.subscribe).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await advance(0)
    expect(screen.getByTestId('connection').textContent).toBe('connected')
    expect(session.connect).toHaveBeenCalledTimes(3)
    expect(session.subscribe).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect a private gateway policy close', async () => {
    const { session } = await mount()
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1008))
    await advance(120000)
    expect(screen.getByTestId('connection').textContent).toBe('revoked')
    expect(session.connect).toHaveBeenCalledTimes(1)
  })

  it('retains editable drafts across reconnection without sending', async () => {
    const { session } = await mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), {
      target: { value: 'Keep this draft' },
    })
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    await advance(2100)
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message the agent' }).value,
    ).toBe('Keep this draft')
    expect(readDraft('https://first.example', 'sess_1', 'phone')).toBe('Keep this draft')
    expect(session.send).not.toHaveBeenCalled()
  })

  it('retains an uncertain command identity and payload until the user explicitly retries it', async () => {
    const pending = {
      key: 'exact-pending-receipt',
      text: 'Run the tests',
      mode: 'queue' as const,
      attachmentIds: ['att_1'],
    }
    writePending('https://first.example', 'phone', 'sess_1', pending)
    const { session } = await mount()
    session.send.mockRejectedValueOnce(new RemoteError('unreachable', 'lost acknowledgement'))
    vi.useFakeTimers()
    act(() => session.streams[0]!.close(1006))
    await advance(2100)
    expect(session.send).not.toHaveBeenCalled()
    expect(readPending('https://first.example', 'phone', 'sess_1')).toEqual(pending)
    fireEvent.click(screen.getByRole('button', { name: 'Retry same submission' }))
    await advance(0)
    expect(session.send).toHaveBeenCalledExactlyOnceWith(
      {
        op: 'session.queue',
        sessionId: 'sess_1',
        text: pending.text,
        attachmentIds: pending.attachmentIds,
      },
      pending.key,
    )
    expect(readPending('https://first.example', 'phone', 'sess_1')).toEqual(pending)
  })
})

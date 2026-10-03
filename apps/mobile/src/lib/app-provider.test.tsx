// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from './app-state'
import { MemoryDeviceStore } from './device-key'
import type { ConnectionState } from './session'

const control = vi.hoisted<{
  state: ConnectionState
  change: (state: ConnectionState) => void
  connect: ReturnType<typeof vi.fn<() => void>>
  query: ReturnType<typeof vi.fn<(op: string) => Promise<unknown>>>
}>(() => ({
  state: 'connected',
  change: (_state: ConnectionState): void => {},
  connect: vi.fn(),
  query: vi.fn<(op: string) => Promise<unknown>>(),
}))
vi.mock('./session', () => ({
  MobileSession: class {
    capabilities = ['project.list', 'session.list']
    constructor(options: { onState: (state: ConnectionState) => void }) {
      control.change = (state) => {
        control.state = state
        options.onState(state)
      }
    }
    get usable(): boolean {
      return control.state === 'connected'
    }
    get state(): ConnectionState {
      return control.state
    }
    async connect(): Promise<ConnectionState> {
      control.connect()
      control.change('connected')
      return 'connected'
    }
    supports(): boolean {
      return false
    }
    query(op: string): Promise<unknown> {
      return control.query(op)
    }
  },
}))

function Probe(): React.ReactNode {
  const app = useApp()
  return <p>{`${app.connection}:${app.projects.length}:${app.sessions.length}`}</p>
}
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('revocation privacy', () => {
  it('clears workspace metadata, ignores late reads, and does not reconnect on foreground', async () => {
    let resolveProjects: ((value: unknown) => void) | undefined
    control.query.mockImplementation(async () => [{}])
    render(
      <AppProvider store={new MemoryDeviceStore()}>
        <Probe />
      </AppProvider>,
    )
    await waitFor(() => expect(screen.getByText('connected:1:1')).toBeTruthy())
    control.query.mockImplementation((op) =>
      op === 'project.list'
        ? new Promise((resolve) => {
            resolveProjects = resolve
          })
        : Promise.resolve([{}]),
    )
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(resolveProjects).toBeDefined())
    act(() => {
      control.change('revoked')
    })
    expect(screen.getByText('revoked:0:0')).toBeTruthy()
    await act(async () => {
      resolveProjects?.([{}])
    })
    expect(screen.getByText('revoked:0:0')).toBeTruthy()
    control.connect.mockClear()
    act(() => {
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(control.connect).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    disconnect(): void {}
    query(op: string): Promise<unknown> {
      return control.query(op)
    }
  },
}))

function Probe(): React.ReactNode {
  const app = useApp()
  return <>
    <p>{`${app.connection}:${app.projects.length}:${app.sessions.length}`}</p>
    <p data-testid="origin">{app.origin}</p>
    <p data-testid="computers">{app.computers.map((computer) => computer.origin).join(',')}</p>
    <button onClick={() => app.addComputer('https://studio.tailnet.ts.net:8443/#pair=invite', 'Studio')}>Add private computer</button>
    <button onClick={() => void app.forget()}>Forget selected</button>
  </>
}
afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
})

describe('private computer origin selection', () => {
  it('opens the destination PWA, clears old metadata and never creates a cross-origin client', async () => {
    control.query.mockResolvedValue([{}])
    const navigate = vi.fn()
    render(<AppProvider store={new MemoryDeviceStore()} navigateTo={navigate}><Probe /></AppProvider>)
    await screen.findByText('connected:1:1')
    control.connect.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Add private computer' }))
    expect(navigate).toHaveBeenCalledOnce()
    const destination = new URL(navigate.mock.calls[0]![0] as string)
    expect(destination.origin).toBe('https://studio.tailnet.ts.net:8443')
    expect(new URLSearchParams(destination.hash.slice(1)).get('pair')).toBe('invite')
    expect(screen.getByText('unpaired:0:0')).toBeTruthy()
    expect(control.connect).not.toHaveBeenCalled()
  })
  it('starts at the serving origin and forgets only that computer’s key and receipts', async () => {
    const other = 'https://travel.tailnet.ts.net'
    localStorage.setItem('ari.remote.origin', other)
    sessionStorage.setItem(`ari.pending:${location.origin}:phone:same`, 'current')
    sessionStorage.setItem(`ari.pending:${other}:phone:same`, 'other')
    control.query.mockResolvedValue([])
    render(<AppProvider store={new MemoryDeviceStore()}><Probe /></AppProvider>)
    await screen.findByText('connected:0:0')
    expect(screen.getByTestId('origin').textContent).toBe(location.origin)
    fireEvent.click(screen.getByRole('button', { name: 'Forget selected' }))
    await waitFor(() => expect(screen.getByTestId('computers').textContent).toBe(other))
    expect(sessionStorage.getItem(`ari.pending:${location.origin}:phone:same`)).toBeNull()
    expect(sessionStorage.getItem(`ari.pending:${other}:phone:same`)).toBe('other')
  })
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

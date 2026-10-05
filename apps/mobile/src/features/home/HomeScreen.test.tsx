// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { HomeScreen } from './HomeScreen'

function summary(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return { id, projectId: 'ari', title: id, updatedAt: Date.now(), messageCount: 1, ...fields }
}
const app = vi.hoisted(() => ({
  origin: 'https://studio.tailnet.ts.net',
  connection: 'connected',
  projects: [
    { id: 'ari', name: 'Ari', sessionCount: 2 },
    { id: 'site', name: 'Website', sessionCount: 1 },
  ],
  sessions: [] as SessionSummary[],
  error: null as string | null,
  refreshing: false,
  refresh: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  session: {
    usable: true,
    supports: vi.fn((_op: string) => true),
    query: vi.fn<(op: string, params: unknown) => Promise<unknown>>(),
    send: vi.fn<(command: unknown) => Promise<unknown>>(),
  },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))

const handlers = { onOpen: vi.fn(), onNewSession: vi.fn(), onSettings: vi.fn() }
beforeEach(() => {
  app.connection = 'connected'
  app.error = null
  app.sessions = [
    summary('Fix pairing', { status: 'waiting-approval' }),
    summary('Refactor shell', { status: 'running' }),
    summary('Landing page', { projectId: 'site' }),
    summary('Old spike', { archived: true }),
  ]
  app.session.supports.mockImplementation(() => true)
  app.session.send.mockResolvedValue({ ok: true })
  app.session.query.mockResolvedValue({
    items: [
      {
        sessionId: 'Fix pairing',
        projectId: 'ari',
        title: 'Fix pairing',
        status: 'waiting-approval',
        updatedAt: Date.now(),
        seq: 1,
        pendingApprovals: [{ approvalId: 'a', toolName: 'Bash', summaryJson: '{}', options: [] }],
        pendingInputs: [],
        error: null,
      },
    ],
    nextCursor: null,
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const shelf = (name: string): HTMLElement => screen.getByRole('region', { name })

describe('home', () => {
  it('opens on what needs the user, then what is working, then the rest', async () => {
    render(<HomeScreen {...handlers} />)
    const needsYou = await screen.findByRole('region', { name: 'Needs you' })
    expect(within(needsYou).getByText('Wants to use Bash')).toBeTruthy()
    expect(within(shelf('Working')).getByText('Refactor shell')).toBeTruthy()
    expect(within(shelf('Recent')).getByText('Landing page')).toBeTruthy()
    expect(screen.queryByText('Old spike')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Fix pairing' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('Fix pairing')
  })

  it('names the computer and its connection, and leads to settings', () => {
    render(<HomeScreen {...handlers} />)
    expect(screen.getByRole('status', { name: 'studio, Connected' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(handlers.onSettings).toHaveBeenCalledOnce()
  })

  it('narrows to a project, and to a search', async () => {
    render(<HomeScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Website' }))
    expect(screen.getByText('Landing page')).toBeTruthy()
    expect(screen.queryByText('Refactor shell')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), {
      target: { value: 'refactor' },
    })
    expect(screen.getByText('Refactor shell')).toBeTruthy()
    expect(screen.queryByText('Landing page')).toBeNull()
  })

  it('keeps archived sessions behind a toggle', () => {
    render(<HomeScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
    expect(within(shelf('Archived')).getByText('Old spike')).toBeTruthy()
  })

  it('starts a new chat from the round button, when the computer allows it', () => {
    const { unmount } = render(<HomeScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(handlers.onNewSession).toHaveBeenCalledOnce()
    unmount()
    app.session.supports.mockImplementation((op) => op !== 'session.create')
    render(<HomeScreen {...handlers} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New chat' }).disabled).toBe(true)
  })

  it('says so when it cannot check what needs the user', async () => {
    app.session.query.mockRejectedValue(new Error('The computer did not answer.'))
    render(<HomeScreen {...handlers} />)
    expect((await screen.findByRole('alert')).textContent).toContain('did not answer')
  })

  it('invites a first session when there are none', () => {
    app.sessions = []
    app.session.query.mockResolvedValue({ items: [], nextCursor: null })
    render(<HomeScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start a session' }))
    expect(handlers.onNewSession).toHaveBeenCalledOnce()
  })

  it('offers reconnecting while the computer is out of reach', () => {
    app.connection = 'unreachable'
    render(<HomeScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(app.reconnect).toHaveBeenCalledOnce()
  })

  it('pins, renames and archives from a press-and-hold menu', async () => {
    render(<HomeScreen {...handlers} />)
    const hold = (): void => {
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Landing page' }))
    }
    hold()
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.update',
        sessionId: 'Landing page',
        pinned: true,
      }),
    )
    hold()
    fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), {
      target: { value: 'Launch page' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.update',
        sessionId: 'Landing page',
        title: 'Launch page',
      }),
    )
    hold()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.archive',
        sessionId: 'Landing page',
      }),
    )
    expect(app.refresh).toHaveBeenCalledTimes(3)
  })

  it('refreshes when the list is pulled down from its top', () => {
    render(<HomeScreen {...handlers} />)
    const list = screen.getByTestId('home-scroll')
    fireEvent.touchStart(list, { touches: [{ clientY: 10 }] })
    fireEvent.touchMove(list, { touches: [{ clientY: 210 }] })
    fireEvent.touchEnd(list)
    expect(app.refresh).toHaveBeenCalledOnce()
  })
})

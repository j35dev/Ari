import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { useToast } from '@ari/ui/toast'
import { AppProviders, App } from './App'
import { BRANCH_POLL_MS, SessionBranchChip } from './features/session/SessionBranchChip'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { MAX_PANES, paneCount } from './features/split/split-layout'

function ToastProbe() {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast({ title: 'Ready', tone: 'info' })}>
      ping toast
    </button>
  )
}

describe('AppProviders', () => {
  it('lets useToast consumers fire without a wrapping gallery', async () => {
    const user = userEvent.setup()
    render(
      <AppProviders>
        <ToastProbe />
      </AppProviders>,
    )

    await user.click(screen.getByRole('button', { name: 'ping toast' }))
    expect(await screen.findByText('Ready')).toBeInTheDocument()
  })
})

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('./lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

describe('SessionBranchChip', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'session.workspace') return { path: 'C:\\repos\\demo' }
      if (method === 'project.list')
        return [{ id: 'proj_1', name: 'Demo', path: 'C:\\repos\\demo' }]
      if (method === 'git.status') return { isRepo: true, branch: 'feat/demo', files: [] }
      throw new Error(`unexpected method: ${String(method)}`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('asks git.status with the session scope, never a resolved path', async () => {
    render(<SessionBranchChip sessionId="sess_1" />)

    expect(await screen.findByText('feat/demo')).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('git.status', { sessionId: 'sess_1' })
    expect(invokeMock).not.toHaveBeenCalledWith('session.workspace', expect.anything())
  })

  it('stays hidden when the session workspace is unavailable', async () => {
    invokeMock.mockImplementation(async (method) => {
      if (method === 'git.status') throw new Error('session workspace is unavailable')
      throw new Error(`unexpected method: ${String(method)}`)
    })

    render(<SessionBranchChip sessionId="sess_1" />)
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('git.status', { sessionId: 'sess_1' })
    })

    expect(screen.queryByTitle('Active branch')).not.toBeInTheDocument()
  })

  it('refreshes the readout when the branch changes behind the open session', async () => {
    vi.useFakeTimers()
    try {
      render(<SessionBranchChip sessionId="sess_1" />)
      // Flush the initial status round-trip without findByText, which cannot
      // tick under fake timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('feat/demo')).toBeInTheDocument()

      invokeMock.mockImplementation(async (method) => {
        if (method === 'git.status') return { isRepo: true, branch: 'fix/other', files: [] }
        throw new Error(`unexpected method: ${String(method)}`)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BRANCH_POLL_MS)
      })
      expect(screen.getByText('fix/other')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the readout when the workspace stops being a repo', async () => {
    vi.useFakeTimers()
    try {
      render(<SessionBranchChip sessionId="sess_1" />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('feat/demo')).toBeInTheDocument()

      invokeMock.mockImplementation(async (method) => {
        if (method === 'git.status') return { isRepo: false, branch: null, files: [] }
        throw new Error(`unexpected method: ${String(method)}`)
      })
      // A single miss means nothing; three consecutive misses clear it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BRANCH_POLL_MS)
      })
      expect(screen.getByText('feat/demo')).toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * BRANCH_POLL_MS)
      })
      expect(screen.queryByTitle('Active branch')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the readout across a transient miss between successful polls', async () => {
    vi.useFakeTimers()
    try {
      render(<SessionBranchChip sessionId="sess_1" />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('feat/demo')).toBeInTheDocument()

      let calls = 0
      invokeMock.mockImplementation(async (method) => {
        if (method !== 'git.status') throw new Error(`unexpected method: ${String(method)}`)
        calls += 1
        if (calls === 1) return { isRepo: false, branch: null, files: [] }
        return { isRepo: true, branch: 'feat/demo', files: [] }
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * BRANCH_POLL_MS)
      })
      expect(screen.getByText('feat/demo')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays hidden outside a git repo', async () => {
    invokeMock.mockImplementation(async (method) => {
      if (method === 'git.status') return { isRepo: false, branch: null, files: [] }
      throw new Error(`unexpected method: ${String(method)}`)
    })

    render(<SessionBranchChip sessionId="sess_1" />)
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('git.status', { sessionId: 'sess_1' })
    })

    expect(screen.queryByTitle('Active branch')).not.toBeInTheDocument()
  })
})

describe('Shell session navigation keys', () => {
  const NOW = Date.now()
  beforeEach(() => {
    splitLayoutActions.reset()
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      switch (method) {
        case 'ping':
          return 'pong'
        case 'app.info':
          return { homeDir: 'C:\\Users\\tester' }
        case 'session.list':
          return [
            {
              id: 'sess-alpha',
              projectId: 'adhoc',
              title: 'Alpha',
              updatedAt: NOW - 60_000,
              messageCount: 1,
            },
            {
              id: 'sess-beta',
              projectId: 'adhoc',
              title: 'Beta',
              updatedAt: NOW - 120_000,
              messageCount: 1,
            },
          ]
        case 'project.list':
          return [{ id: 'proj-ari', name: 'Ari', path: '/projects/ari', status: 'ok', open: true }]
        case 'providers.detect':
          return []
        case 'providers.models':
          return []
        case 'files.index':
          return { paths: [] }
        case 'endpoints.list':
          return []
        case 'session.load':
          return { session: null, activeTurnId: null }
        default:
          throw new Error(`unexpected method: ${String(method)}`)
      }
    })
  })

  it('Mod+2 opens the second session in sidebar order', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: '2', ctrlKey: true })

    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-beta' })
      },
      { timeout: 10_000 },
    )
  })

  it('Ctrl+Tab cycles forward through sessions and wraps', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-alpha' })
      },
      { timeout: 10_000 },
    )

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-beta' })
      },
      { timeout: 10_000 },
    )
  })

  it('Ctrl+Shift+Tab cycles backward', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })
    // Wraps from "nothing active" to the last row.
    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-beta' })
      },
      { timeout: 10_000 },
    )
  })

  it('Mod+N asks which project to run in, then creates the session there', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    // The session's project is no longer implied — the shortcut opens the
    // same picker the sidebar's New session button does.
    const menu = await screen.findByRole(
      'menu',
      { name: 'New session in project' },
      {
        timeout: 10_000,
      },
    )
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ari' }))

    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith(
          'session.create',
          expect.objectContaining({ projectId: 'proj-ari' }),
        )
      },
      { timeout: 10_000 },
    )
  })
})

describe('Shell split panes', () => {
  const NOW = Date.now()

  /** Alpha on the left, Beta on the right — the split focuses the new pane. */
  const openTwoPanes = (): void => {
    const first = splitLayoutSnapshot().focusedPaneId
    splitLayoutActions.assign(first, 'sess-alpha')
    splitLayoutActions.split(first, 'right')
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sess-beta')
  }

  const sidebar = (): HTMLElement => screen.getByRole('complementary')
  const row = (title: string): HTMLElement => {
    const found = within(sidebar()).getByText(title).closest('button')
    if (found === null) throw new Error(`no sidebar row for ${title}`)
    return found
  }

  beforeEach(() => {
    splitLayoutActions.reset()
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      switch (method) {
        case 'ping':
          return 'pong'
        case 'app.info':
          return { homeDir: 'C:\\Users\\tester' }
        case 'session.list':
          return [
            {
              id: 'sess-alpha',
              projectId: 'adhoc',
              title: 'Alpha',
              updatedAt: NOW - 60_000,
              messageCount: 1,
            },
            {
              id: 'sess-beta',
              projectId: 'adhoc',
              title: 'Beta',
              updatedAt: NOW - 120_000,
              messageCount: 1,
            },
          ]
        case 'project.list':
          return [{ id: 'proj-ari', name: 'Ari', path: '/projects/ari', status: 'ok', open: true }]
        case 'providers.detect':
          return []
        case 'providers.models':
          return []
        case 'files.index':
          return { paths: [] }
        case 'endpoints.list':
          return []
        case 'session.load':
          return { session: null, activeTurnId: null }
        default:
          throw new Error(`unexpected method: ${String(method)}`)
      }
    })
  })

  it('mounts a view per pane, so both sessions load and stream at once', async () => {
    openTwoPanes()
    render(<App />)

    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-alpha' })
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-beta' })
      },
      { timeout: 10_000 },
    )
    const alpha = await screen.findByRole('region', { name: 'Alpha' }, { timeout: 10_000 })
    expect(alpha).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Beta' })).toHaveClass('border-accent/40')
  })

  it('marks the focused pane, and moves the sidebar highlight with it', async () => {
    openTwoPanes()
    render(<App />)

    const beta = await screen.findByRole('region', { name: 'Beta' }, { timeout: 10_000 })
    expect(beta).toHaveClass('border-accent/40')
    expect(screen.getByRole('region', { name: 'Alpha' })).toHaveClass('border-border/60')
    expect(row('Beta')).toHaveClass('bg-accent/15')
    expect(row('Alpha')).not.toHaveClass('bg-accent/15')

    fireEvent.pointerDown(screen.getByRole('region', { name: 'Alpha' }))

    await vi.waitFor(() => {
      expect(screen.getByRole('region', { name: 'Alpha' })).toHaveClass('border-accent/40')
    })
    expect(row('Alpha')).toHaveClass('bg-accent/15')
    expect(row('Beta')).not.toHaveClass('bg-accent/15')
  })

  it('keeps the one-pane view chrome-free, as it was before the split existed', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-beta' })
      },
      { timeout: 10_000 },
    )

    expect(screen.queryByRole('region', { name: 'Beta' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close Beta' })).not.toBeInTheDocument()
  })

  it('keeps the welcome panel while the one pane is empty', async () => {
    render(<App />)

    expect(await screen.findByText('Quick Actions', {}, { timeout: 10_000 })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Empty pane' })).not.toBeInTheDocument()
  })

  it('shows the split itself once there is more than one pane, empty or not', async () => {
    splitLayoutActions.split(splitLayoutSnapshot().focusedPaneId, 'right')
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    expect(screen.getAllByRole('region', { name: 'Empty pane' })).toHaveLength(2)
    expect(screen.getAllByText('No session in this pane')).toHaveLength(2)
  })

  it('splits a pane from its own right-click menu, leaving the new pane blank', async () => {
    openTwoPanes()
    render(<App />)
    const alpha = await screen.findByRole('region', { name: 'Alpha' }, { timeout: 10_000 })

    fireEvent.contextMenu(alpha, { clientX: 60, clientY: 60 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split down' }))

    // Three panes now: the new one has the focus and is waiting for a session.
    expect(screen.getByRole('region', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.getAllByRole('region', { name: 'Empty pane' })).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Empty pane' })).toHaveClass('border-accent/40')
  })

  it('splits from a right-click on the one-pane view, which has no frame', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })
    fireEvent.keyDown(window, { key: '2', ctrlKey: true })
    const pane = await screen.findByText('No messages yet — say hello.', {}, { timeout: 10_000 })

    fireEvent.contextMenu(pane, { clientX: 60, clientY: 60 })
    expect(screen.getByRole('menu')).toHaveAccessibleName('Beta pane')
    // Nothing to close beside or zoom away from while it is the only pane.
    expect(screen.queryByRole('menuitem', { name: 'Close pane' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Split down' }))

    // The split leaves the new pane blank for a session to be dragged into.
    expect(screen.getAllByRole('region', { name: 'Empty pane' })).toHaveLength(1)
    expect(screen.getByRole('separator', { name: 'Resize Beta and Empty pane' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    )
  })

  it('splits the pane the user is in from the keyboard', async () => {
    openTwoPanes()
    render(<App />)
    await screen.findByRole('region', { name: 'Beta' }, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })

    // The focused pane splits; its new neighbour is blank until something is
    // dropped in it, and it is the vertical divider that separates them.
    expect(screen.getByRole('region', { name: 'Empty pane' })).toHaveClass('border-accent/40')
    expect(screen.getByRole('separator', { name: 'Resize Beta and Empty pane' })).toHaveAttribute(
      'aria-orientation',
      'vertical',
    )
  })

  it('splits down with the shifted chord, the other axis', async () => {
    openTwoPanes()
    render(<App />)
    await screen.findByRole('region', { name: 'Beta' }, { timeout: 10_000 })

    // Shift+backslash is `|` on the layouts most people have.
    fireEvent.keyDown(window, { key: '|', ctrlKey: true, shiftKey: true })

    expect(screen.getByRole('separator', { name: 'Resize Beta and Empty pane' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    )
  })

  it('moves focus to the pane the arrow points at', async () => {
    openTwoPanes()
    render(<App />)
    await screen.findByRole('region', { name: 'Beta' }, { timeout: 10_000 })
    expect(row('Beta')).toHaveClass('bg-accent/15')

    fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })

    expect(row('Alpha')).toHaveClass('bg-accent/15')
    expect(row('Beta')).not.toHaveClass('bg-accent/15')
  })

  it('says why a chord did nothing when the layout is already full', async () => {
    openTwoPanes()
    while (paneCount(splitLayoutSnapshot()) < MAX_PANES) {
      splitLayoutActions.split(splitLayoutSnapshot().focusedPaneId, 'right')
    }
    render(<App />)
    await screen.findByRole('region', { name: 'Alpha' }, { timeout: 10_000 })

    // The splits that filled the layout left four panes empty, which is what
    // the refused chord must leave alone.
    const blanks = MAX_PANES - 2
    expect(screen.getAllByRole('region', { name: 'Empty pane' })).toHaveLength(blanks)

    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })

    expect(
      await screen.findByText(`A layout holds at most ${String(MAX_PANES)} panes`),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('region', { name: 'Empty pane' })).toHaveLength(blanks)
  })

  it('leaves the pane chords alone while another view has the screen', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    // Settings stands in for the pane area, so neither the chord nor the palette
    // may split a layout the user cannot see — the blank pane would only turn up
    // on the way back.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.click(await screen.findByRole('option', { name: /Go to Settings/ }))
    const back = await screen.findByRole('button', { name: 'Back' }, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: '\\', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('option', { name: /Go to Sessions/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Split pane right/ })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })

    fireEvent.click(back)
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('region', { name: 'Empty pane' })).not.toBeInTheDocument()
  })

  it('leaves the pane chords to a field that has the keyboard', async () => {
    render(<App />)
    const search = await screen.findByRole('searchbox', {}, { timeout: 10_000 })

    fireEvent.keyDown(search, { key: '\\', ctrlKey: true })

    expect(screen.queryByRole('region', { name: 'Empty pane' })).not.toBeInTheDocument()
  })
})

describe('Starting a session with no project yet', () => {
  beforeEach(() => {
    splitLayoutActions.reset()
    invokeMock.mockReset()
    rpcMocks.subscribe.mockReset()
    rpcMocks.subscribe.mockImplementation(() => () => undefined)
    localStorage.clear()
    invokeMock.mockImplementation(async (method) => {
      switch (method) {
        case 'ping':
          return 'pong'
        case 'app.info':
          return { homeDir: 'C:\\Users\\tester' }
        case 'session.list':
          return []
        case 'project.list':
          return []
        case 'dialog.pickFolder':
          return { path: 'C:\\work\\ari' }
        case 'project.open':
          return { id: 'proj-new', name: 'Ari', path: 'C:\\work\\ari' }
        case 'session.create':
          return { sessionId: 'sess-new' }
        case 'providers.detect':
        case 'providers.models':
        case 'endpoints.list':
          return []
        case 'files.index':
          return { paths: [] }
        case 'session.load':
          return { session: null, activeTurnId: null }
        default:
          throw new Error(`unexpected method: ${String(method)}`)
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('routes New session through the folder picker and creates inside the picked folder', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Add a project to start' }, { timeout: 10_000 })

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

    // No projects means no menu to pick from — the folder dialog *is* the
    // choice, so the button is never a dead end. The session lands in the
    // picked project rather than the old 'adhoc' bucket, which is what gives
    // the terminal rail a real workspace to open in.
    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('dialog.pickFolder', { defaultPath: undefined })
        expect(invokeMock).toHaveBeenCalledWith(
          'session.create',
          expect.objectContaining({ projectId: 'proj-new' }),
        )
        expect(invokeMock).not.toHaveBeenCalledWith(
          'session.create',
          expect.objectContaining({ projectId: 'adhoc' }),
        )
      },
      { timeout: 10_000 },
    )
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does nothing when the folder picker is cancelled', async () => {
    invokeMock.mockImplementation(async (method) => {
      switch (method) {
        case 'ping':
          return 'pong'
        case 'app.info':
          return { homeDir: 'C:\\Users\\tester' }
        case 'session.list':
          return []
        case 'project.list':
          return []
        case 'dialog.pickFolder':
          return { path: null }
        case 'providers.detect':
        case 'providers.models':
        case 'endpoints.list':
          return []
        case 'files.index':
          return { paths: [] }
        default:
          throw new Error(`unexpected method: ${String(method)}`)
      }
    })

    render(<App />)
    await screen.findByRole('button', { name: 'Add a project to start' }, { timeout: 10_000 })

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('dialog.pickFolder', { defaultPath: undefined })
    })
    expect(invokeMock.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
  })

  it('offers a project instead of a shell the path jail would refuse', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Add a project to start' }, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: '`', ctrlKey: true })

    // terminal.create jails its working directory against the registered
    // project folders, so with none registered there is nowhere to open a
    // shell. The rail asks for a project instead of spawning one that comes
    // back refused.
    const rail = await screen.findByRole('complementary', { name: 'Terminal' })
    expect(
      await within(rail).findByText(
        'Add a project to open a terminal — shells run inside a project folder.',
      ),
    ).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Add project' })).toBeInTheDocument()
    expect(invokeMock.mock.calls.some(([method]) => method === 'terminal.create')).toBe(false)
  })
})

describe('Project session import flow', () => {
  beforeEach(() => {
    splitLayoutActions.reset()
    invokeMock.mockReset()
    rpcMocks.subscribe.mockReset()
    rpcMocks.subscribe.mockImplementation(() => () => undefined)
    invokeMock.mockImplementation(async (method) => {
      switch (method) {
        case 'ping':
          return 'pong'
        case 'app.info':
          return { homeDir: '/Users/tester' }
        case 'session.list':
          return []
        case 'project.list':
          return [{ id: 'proj-ari', name: 'Ari', path: '/projects/ari', status: 'ok', open: true }]
        case 'providers.detect':
        case 'providers.models':
        case 'endpoints.list':
          return []
        case 'files.index':
          return { paths: [] }
        case 'sessions.importable':
          return [
            {
              kind: 'pi',
              id: 'pi-1',
              candidateId: 'candidate-one',
              cwd: '/projects/ari',
              title: 'Imported chat',
              startedAt: 1,
              updatedAt: 2,
              messageCount: 1,
              imported: false,
            },
          ]
        case 'sessions.import':
          return { ok: true, sessionId: 'sess-imported', title: 'Imported chat', messageCount: 1 }
        case 'session.load':
          return { session: null, activeTurnId: null }
        default:
          throw new Error(`unexpected method: ${String(method)}`)
      }
    })
  })

  it('opens the project import modal and selects the imported Ari chat', async () => {
    const user = userEvent.setup()
    render(<App />)
    const project = await screen.findByRole('button', { name: 'Ari0' }, { timeout: 10_000 })

    await user.pointer({ keys: '[MouseRight]', target: project })
    await user.click(screen.getByRole('menuitem', { name: 'Import' }))
    await user.click(screen.getByRole('button', { name: /Pi/ }))
    await user.click(await screen.findByRole('button', { name: 'Import Imported chat' }))

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('session.load', { sessionId: 'sess-imported' })
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Shell live sidebar feed', () => {
  const NOW = Date.now()
  let listCalls: number

  /** Callbacks the Shell (and any child) registered for session.events. */
  const sessionFeedHandlers = (): Array<(payload: unknown) => void> =>
    (
      rpcMocks.subscribe.mock.calls as unknown as Array<
        [string, Record<string, unknown>, (payload: unknown) => void]
      >
    )
      .filter(([name]) => name === 'session.events')
      .map(([, , onEvent]) => onEvent)

  beforeEach(() => {
    splitLayoutActions.reset()
    invokeMock.mockReset()
    rpcMocks.subscribe.mockReset()
    rpcMocks.subscribe.mockImplementation(() => () => undefined)
    listCalls = 0
    invokeMock.mockImplementation(async (method) => {
      switch (method) {
        case 'ping':
          return 'pong'
        case 'app.info':
          return { homeDir: 'C:\\Users\\tester' }
        case 'session.list':
          listCalls++
          return listCalls === 1
            ? [
                {
                  id: 'sess-alpha',
                  projectId: 'proj-ari',
                  title: 'New session',
                  updatedAt: NOW - 60_000,
                  messageCount: 0,
                },
              ]
            : [
                {
                  id: 'sess-alpha',
                  projectId: 'proj-ari',
                  title: 'Fixed the build',
                  updatedAt: NOW - 1_000,
                  messageCount: 2,
                },
              ]
        case 'session.create':
          return { sessionId: 'sess-new' }
        case 'project.list':
          return [{ id: 'proj-ari', name: 'Ari', path: '/projects/ari', status: 'ok', open: true }]
        case 'providers.detect':
          return []
        case 'providers.models':
          return []
        case 'files.index':
          return { paths: [] }
        case 'endpoints.list':
          return []
        case 'session.load':
          return { session: null, activeTurnId: null }
        default:
          throw new Error(`unexpected method: ${String(method)}`)
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renames the row as soon as the engine stamps a title on first prompt', async () => {
    render(<App />)
    await vi.waitFor(() => expect(sessionFeedHandlers()).not.toHaveLength(0))

    for (const onEvent of sessionFeedHandlers()) {
      onEvent({
        sessionId: 'sess-alpha',
        event: {
          seq: 3,
          at: Date.now(),
          sessionId: 'sess-alpha',
          type: 'session.updated',
          title: 'Fixed the build',
        },
      })
    }

    // Debounced refetch pulls the engine's fresh summary; the row updates
    // without any explicit user action.
    await vi.waitFor(() => expect(screen.getByText('Fixed the build')).toBeInTheDocument(), {
      timeout: 3_000,
    })
  })

  it('stops offering a chatty session as pristine, so Mod+N creates a new one', async () => {
    render(<App />)
    await vi.waitFor(() => expect(sessionFeedHandlers()).not.toHaveLength(0))

    for (const onEvent of sessionFeedHandlers()) {
      onEvent({
        sessionId: 'sess-alpha',
        event: {
          seq: 2,
          at: Date.now(),
          sessionId: 'sess-alpha',
          type: 'user.message.added',
          message: { id: 'msg_1' },
        },
      })
    }
    // Wait for the refetch to be *committed*, not merely requested: the
    // reuse check reads session state, so waiting on the call count alone
    // races the render and Mod+N can still see the stale pristine row. The
    // second summary carries the new title, so its row proves the commit.
    await vi.waitFor(() => expect(screen.getByText('Fixed the build')).toBeInTheDocument(), {
      timeout: 3_000,
    })
    expect(listCalls).toBeGreaterThanOrEqual(2)

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    const menu = await screen.findByRole('menu', { name: 'New session in project' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ari' }))

    await vi.waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith(
          'session.create',
          expect.objectContaining({ projectId: 'proj-ari' }),
        )
      },
      { timeout: 3_000 },
    )
  })

  it('does not refetch on streaming deltas', async () => {
    render(<App />)
    await vi.waitFor(() => expect(sessionFeedHandlers()).not.toHaveLength(0))
    await vi.waitFor(() => expect(listCalls).toBe(1))

    for (const onEvent of sessionFeedHandlers()) {
      onEvent({
        sessionId: 'sess-alpha',
        event: {
          seq: 4,
          at: Date.now(),
          sessionId: 'sess-alpha',
          type: 'assistant.parts.appended',
          parts: [],
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(listCalls).toBe(1)
  })
})

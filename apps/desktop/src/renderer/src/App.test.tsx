import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { useToast } from '@ari/ui/toast'
import { BranchChip, AppProviders, App } from './App'

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

describe('BranchChip', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'session.load') return { session: { projectId: 'proj_1' } }
      if (method === 'project.list')
        return [{ id: 'proj_1', name: 'Demo', path: 'C:\\repos\\demo' }]
      if (method === 'git.status') return { isRepo: true, branch: 'feat/demo', files: [] }
      throw new Error(`unexpected method: ${String(method)}`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('asks git.status for the registered project folder, not the raw id', async () => {
    render(<BranchChip sessionId="sess_1" />)

    expect(await screen.findByText('feat/demo')).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('git.status', { path: 'C:\\repos\\demo' })
    expect(invokeMock).not.toHaveBeenCalledWith('git.status', { path: 'proj_1' })
  })

  it('stays hidden when the session has no registered project folder', async () => {
    invokeMock.mockImplementation(async (method) => {
      if (method === 'session.load') return { session: { projectId: 'adhoc' } }
      if (method === 'project.list') return []
      throw new Error(`unexpected method: ${String(method)}`)
    })

    render(<BranchChip sessionId="sess_1" />)
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('project.list')
    })

    expect(screen.queryByTitle('Active branch')).not.toBeInTheDocument()
  })

  it('stays hidden outside a git repo', async () => {
    invokeMock.mockImplementation(async (method) => {
      if (method === 'session.load') return { session: { projectId: 'proj_1' } }
      if (method === 'project.list')
        return [{ id: 'proj_1', name: 'Demo', path: 'C:\\repos\\demo' }]
      if (method === 'git.status') return { isRepo: false, branch: null, files: [] }
      throw new Error(`unexpected method: ${String(method)}`)
    })

    render(<BranchChip sessionId="sess_1" />)
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('git.status', { path: 'C:\\repos\\demo' })
    })

    expect(screen.queryByTitle('Active branch')).not.toBeInTheDocument()
  })
})

describe('Shell session navigation keys', () => {
  const NOW = Date.now()
  beforeEach(() => {
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
          return []
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

  it('Mod+N creates a new session via the reuse path', async () => {
    render(<App />)
    await screen.findByText('Alpha', {}, { timeout: 10_000 })

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    // Reuses the pristine adhoc session or creates one; either way the
    // command path runs.
    await vi.waitFor(
      () => {
        const created = invokeMock.mock.calls.some(
          ([method]) => method === 'session.create',
        )
        const reused = invokeMock.mock.calls.some(
          ([method, params]) =>
            method === 'session.load' &&
            (params as { sessionId?: string } | undefined)?.sessionId !== undefined,
        )
        expect(created || reused).toBe(true)
      },
      { timeout: 10_000 },
    )
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
                  projectId: 'adhoc',
                  title: 'New session',
                  updatedAt: NOW - 60_000,
                  messageCount: 0,
                },
              ]
            : [
                {
                  id: 'sess-alpha',
                  projectId: 'adhoc',
                  title: 'Fixed the build',
                  updatedAt: NOW - 1_000,
                  messageCount: 2,
                },
              ]
        case 'session.create':
          return { sessionId: 'sess-new' }
        case 'project.list':
          return []
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
    await vi.waitFor(
      () => expect(screen.getByText('Fixed the build')).toBeInTheDocument(),
      { timeout: 3_000 },
    )
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
    await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2), { timeout: 3_000 })

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })

    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.some(([method]) => method === 'session.create')).toBe(true)
    })
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

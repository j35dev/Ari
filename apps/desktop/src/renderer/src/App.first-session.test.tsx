import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import type { Session } from '@ari/contracts/session'
import type { RpcResults, SessionCreateParams, SessionSummary } from '@ari/contracts/rpc'
import { settingsSchema } from '@ari/contracts/settings'
import type { OnboardingWorkspaceProps } from './features/onboarding/OnboardingGate'
import { App } from './App'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { activeSessionOf } from './features/split/split-layout'
import { spaceActions } from './features/spaces'
import { keepAliveActions } from './features/session/session-keep-alive'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('./lib/rpc', () => ({ rpc: rpcMocks }))
vi.mock('./features/focus/FocusPill', () => ({ FocusPill: () => null }))
vi.mock('./features/onboarding/OnboardingGate', () => ({
  OnboardingGate: ({ children }: { children: (props: OnboardingWorkspaceProps) => ReactNode }) =>
    children({ onOpenSetup: () => undefined, setupCovered: false, onboardingOutcome: null }),
}))

const PROJECT: Project = {
  id: 'project-first',
  name: 'First project',
  path: 'C:\\scratch\\first-project',
  colorIndex: 0,
  createdAt: 1,
  lastOpenedAt: 1,
  status: 'ok',
  open: true,
}
let projects: Project[]
type Endpoint = RpcResults['endpoints.list'][number]
let endpoints: Endpoint[]
let sessions: SessionSummary[]
let models: Map<string, Session>
let replayListeners: Map<string, (payload: unknown) => void>
let replayAutomatically: boolean

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function calls(method: string) {
  return rpcMocks.invoke.mock.calls.filter(([name]) => name === method)
}

function paramsOf(method: string, index = 0): unknown {
  const call = calls(method)[index]
  expect(call).toBeDefined()
  return call?.[1]
}

function recordSession(params: SessionCreateParams, id = 'session-first'): { sessionId: string } {
  const { lead, ...config } = params
  models.set(id, {
    ...config,
    ...(lead ? { lead: true as const } : {}),
    id,
    status: 'idle',
    createdAt: 2,
    updatedAt: 2,
  })
  sessions = [
    ...sessions,
    { id, projectId: params.projectId, title: params.title, messageCount: 0, updatedAt: 2 },
  ]
  return { sessionId: id }
}

function replayDone(sessionId = 'session-first') {
  replayListeners.get(sessionId)?.({ sessionId, replayDone: true, liveTurnId: null })
}

async function settleFocus() {
  await act(
    async () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

async function welcome() {
  render(<App />)
  await screen.findByRole('button', { name: 'Add a project to start' })
  await screen.findByRole('textbox', { name: 'Model id' })
}

async function connectModel() {
  const user = userEvent.setup()
  fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), {
    target: { value: 'http://127.0.0.1:9/v1' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Model id' }), {
    target: { value: 'first-model' },
  })
  screen.getByRole('button', { name: 'Save and choose project' }).focus()
  await user.keyboard('{Enter}')
}

beforeEach(() => {
  localStorage.clear()
  splitLayoutActions.reset()
  keepAliveActions.reset()
  projects = []
  endpoints = []
  sessions = []
  models = new Map()
  replayListeners = new Map()
  replayAutomatically = true
  rpcMocks.invoke.mockReset()
  rpcMocks.subscribe.mockReset()
  rpcMocks.invoke.mockImplementation(async (method: string, value?: unknown) => {
    switch (method) {
      case 'ping':
        return 'pong'
      case 'app.info':
        return { homeDir: 'C:\\scratch' }
      case 'settings.get':
        return settingsSchema.parse({ version: 1, appearance: { reducedMotion: true } })
      case 'project.list':
        return projects
      case 'session.list':
        return sessions
      case 'endpoints.list':
        return endpoints
      case 'providers.detect':
      case 'providers.models':
      case 'providers.efforts':
      case 'session.tasks':
        return []
      case 'session.resume.get':
        return { at: null }
      case 'files.index':
        return { paths: [] }
      case 'plan.get':
        return { items: null }
      case 'session.workspace':
        return { path: PROJECT.path }
      case 'dialog.pickFolder':
        return { path: PROJECT.path }
      case 'project.open':
        projects = [PROJECT]
        return PROJECT
      case 'endpoints.upsert': {
        const endpoint = value as Endpoint
        endpoints = [endpoint]
        return endpoint
      }
      case 'session.create':
        return recordSession(value as SessionCreateParams)
      case 'session.load':
        return {
          session: models.get((value as { sessionId: string }).sessionId),
          activeTurnId: null,
        }
      case 'command.dispatch':
        return { accepted: true }
      default:
        throw new Error(`Unexpected RPC: ${method}`)
    }
  })
  rpcMocks.subscribe.mockImplementation(
    (name: string, params: { sessionId?: string }, listener: (payload: unknown) => void) => {
      if (name === 'session.events' && params.sessionId) {
        replayListeners.set(params.sessionId, listener)
        if (replayAutomatically)
          listener({ sessionId: params.sessionId, replayDone: true, liveTurnId: null })
      }
      return () => undefined
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('first-session recovery', () => {
  it('keeps the first start owned when a duplicate endpoint submit arrives in the same frame', async () => {
    const picker = deferred<{ path: string | null }>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'dialog.pickFolder' ? picker.promise : original(method, params),
    )
    await welcome()
    fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), {
      target: { value: 'http://127.0.0.1:9/v1' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Model id' }), {
      target: { value: 'first-model' },
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a project to start' }))
      fireEvent.submit(screen.getByRole('textbox', { name: 'Model id' }).closest('form')!)
    })
    expect(calls('endpoints.upsert')).toHaveLength(0)
    await act(async () => picker.resolve({ path: PROJECT.path }))
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
  })

  it('saves only once when the endpoint form is submitted twice before its reply', async () => {
    const save = deferred<Endpoint>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'endpoints.upsert' ? save.promise : original(method, params),
    )
    await welcome()
    fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), {
      target: { value: 'http://127.0.0.1:9/v1' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Model id' }), {
      target: { value: 'first-model' },
    })
    const form = screen.getByRole('textbox', { name: 'Model id' }).closest('form')!
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    expect(calls('endpoints.upsert')).toHaveLength(1)
    await act(async () =>
      save.resolve((await original('endpoints.upsert', paramsOf('endpoints.upsert'))) as Endpoint),
    )
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
  })

  it('retains endpoint identity when an upsert persisted but its acknowledgement was lost', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let saves = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      const result = await original(method, params)
      if (method === 'endpoints.upsert' && ++saves === 1) throw new Error('Save reply lost')
      return result
    })
    await welcome()
    await connectModel()
    await screen.findByRole('alert')
    fireEvent.submit(screen.getByRole('textbox', { name: 'Model id' }).closest('form')!)
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
    expect(paramsOf('endpoints.upsert', 1)).toEqual(paramsOf('endpoints.upsert'))
    expect(endpoints).toHaveLength(1)
  })

  it('shows a native picker rejection and retries without saving another endpoint', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let picks = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'dialog.pickFolder' && ++picks === 1)
        throw new Error('Native picker unavailable')
      return original(method, params)
    })
    await welcome()
    await connectModel()
    expect(await screen.findByText('Couldn’t choose a project folder')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Model id' })).toHaveValue('first-model')
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder again' }))
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
    expect(calls('endpoints.upsert')).toHaveLength(1)
    expect(paramsOf('session.create')).toMatchObject({
      projectId: PROJECT.id,
      modelId: `ep:${endpoints[0]!.id}`,
    })
  })

  it('retries opening the chosen path without another picker or endpoint save', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let opens = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'project.open' && ++opens === 1) throw new Error('Folder access refused')
      return original(method, params)
    })
    await welcome()
    await connectModel()
    expect(await screen.findByText('Couldn’t open the project')).toBeVisible()
    expect(screen.getByText(/Folder access refused/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry opening project' }))
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
    expect(calls('dialog.pickFolder')).toHaveLength(1)
    expect(calls('project.open').map((call) => call[1])).toEqual([
      { path: PROJECT.path },
      { path: PROJECT.path },
    ])
    expect(calls('endpoints.upsert')).toHaveLength(1)
  })

  it('checks an unacknowledged creation without resubmitting and offers an explicit recovery', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let creates = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'session.create' && ++creates === 1) throw new Error('Creation reply lost')
      return original(method, params)
    })
    await welcome()
    await connectModel()
    expect(await screen.findByText('Couldn’t confirm the new session')).toBeVisible()
    const checksBefore = calls('session.list').length
    fireEvent.click(screen.getByRole('button', { name: 'Check sessions' }))
    await screen.findByRole('button', { name: 'Start another session' })
    expect(calls('session.list').length).toBeGreaterThan(checksBefore)
    expect(calls('session.create')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(calls('session.create')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Start another session' }))
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(2))
    expect(paramsOf('session.create', 1)).toEqual(paramsOf('session.create'))
    expect(calls('dialog.pickFolder')).toHaveLength(1)
    expect(calls('project.open')).toHaveLength(1)
    expect(calls('endpoints.upsert')).toHaveLength(1)
  })

  it('does not submit again when creation persisted but its reply was lost', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'session.create') {
        recordSession(params as SessionCreateParams)
        throw new Error('Reply lost after persistence')
      }
      return original(method, params)
    })
    await welcome()
    await connectModel()
    await screen.findByText('Couldn’t confirm the new session')
    fireEvent.click(screen.getByRole('button', { name: 'Check sessions' }))
    await screen.findByRole('button', { name: 'Session actions for New session' })
    expect(calls('session.create')).toHaveLength(1)
    expect(activeSessionOf(splitLayoutSnapshot())).toBeNull()
  })

  it('keeps cancellation quiet and reuses the saved endpoint on the next start', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let picks = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'dialog.pickFolder' && ++picks === 1) return { path: null }
      return original(method, params)
    })
    await welcome()
    await connectModel()
    expect(calls('session.create')).toHaveLength(0)
    expect(screen.queryByText(/Couldn’t/)).not.toBeInTheDocument()
    fireEvent.submit(screen.getByRole('textbox', { name: 'Model id' }).closest('form')!)
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
    expect(calls('endpoints.upsert')).toHaveLength(1)
    expect(paramsOf('session.create')).toMatchObject({ modelId: `ep:${endpoints[0]!.id}` })
  })

  it('clears old folder feedback when a fresh saved-model attempt is cancelled', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let picks = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'dialog.pickFolder') {
        if (++picks === 1) throw new Error('Picker unavailable')
        return { path: null }
      }
      return original(method, params)
    })
    await welcome()
    await connectModel()
    await screen.findByText('Couldn’t choose a project folder')
    fireEvent.submit(screen.getByRole('textbox', { name: 'Model id' }).closest('form')!)
    await vi.waitFor(() =>
      expect(screen.queryByText('Couldn’t choose a project folder')).not.toBeInTheDocument(),
    )
    expect(calls('dialog.pickFolder')).toHaveLength(2)
    expect(calls('session.create')).toHaveLength(0)
    expect(calls('endpoints.upsert')).toHaveLength(1)
  })

  it('also retains the chosen model when the primary start button follows cancellation', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let picks = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'dialog.pickFolder' && ++picks === 1) return { path: null }
      return original(method, params)
    })
    await welcome()
    await connectModel()
    fireEvent.click(screen.getByRole('button', { name: 'Add a project to start' }))
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
    expect(paramsOf('session.create')).toMatchObject({ modelId: `ep:${endpoints[0]!.id}` })
    expect(calls('endpoints.upsert')).toHaveLength(1)
  })

  it('keeps a failed session check recoverable without creating again', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    let created = false
    let checks = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'session.create') {
        created = true
        throw new Error('Creation reply lost')
      }
      if (method === 'session.list' && created && ++checks === 1)
        throw new Error('List unavailable')
      return original(method, params)
    })
    await welcome()
    await connectModel()
    await screen.findByText('Couldn’t confirm the new session')
    fireEvent.click(screen.getByRole('button', { name: 'Check sessions' }))
    await screen.findByText('Couldn’t refresh sessions')
    expect(calls('session.create')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Check sessions' }))
    await screen.findByRole('button', { name: 'Start another session' })
    expect(calls('session.create')).toHaveLength(1)
  })

  it('retries refused empty-session setup using the same session identity', async () => {
    projects = [PROJECT]
    recordSession({
      projectId: PROJECT.id,
      title: 'New session',
      driverKind: 'ari-core',
      modelId: null,
      permissionMode: 'ask',
    })
    const original = rpcMocks.invoke.getMockImplementation()!
    let updates = 0
    rpcMocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'command.dispatch' && ++updates === 1)
        return { accepted: false, reason: 'Setup refused' }
      return original(method, params)
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('button', { name: 'Start a new session' })
    await user.keyboard('{Control>}n{/Control}')
    await screen.findByRole('textbox', { name: 'Search projects' })
    await user.keyboard('{Enter}')
    await screen.findByText('Couldn’t prepare the session')
    act(() => splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'session-first'))
    await user.click(screen.getByRole('button', { name: 'Retry session setup' }))
    await vi.waitFor(() => expect(calls('command.dispatch')).toHaveLength(2))
    expect(paramsOf('command.dispatch', 1)).toEqual(paramsOf('command.dispatch'))
    expect(calls('session.create')).toHaveLength(0)
  })

  it('prevents duplicate pending folder requests from repeated start actions', async () => {
    const picker = deferred<{ path: string | null }>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'dialog.pickFolder' ? picker.promise : original(method, params),
    )
    await welcome()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a project to start' }))
      fireEvent.click(screen.getByRole('button', { name: 'New session' }))
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    })
    expect(calls('dialog.pickFolder')).toHaveLength(1)
    await act(async () => picker.resolve({ path: PROJECT.path }))
    await vi.waitFor(() => expect(calls('session.create')).toHaveLength(1))
  })

  it('prevents duplicate creation while a reply is pending', async () => {
    projects = [PROJECT]
    const creation = deferred<{ sessionId: string }>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'session.create' ? creation.promise : original(method, params),
    )
    render(<App />)
    await screen.findByRole('button', { name: 'Start a new session' })
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    const launcher = await screen.findByRole('dialog', { name: 'New session' })
    fireEvent.keyDown(within(launcher).getByRole('textbox', { name: 'Search projects' }), {
      key: 'Enter',
    })
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    const second = screen.queryByRole('dialog', { name: 'New session' })
    if (second)
      fireEvent.keyDown(within(second).getByRole('textbox', { name: 'Search projects' }), {
        key: 'Enter',
      })
    expect(calls('session.create')).toHaveLength(1)
    await act(async () =>
      creation.resolve(recordSession(paramsOf('session.create') as SessionCreateParams)),
    )
  })
})

describe('explicit first-session focus handoff', () => {
  it('does not continue choosing a project when the workspace changed during endpoint saving', async () => {
    const save = deferred<Endpoint>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'endpoints.upsert' ? save.promise : original(method, params),
    )
    await welcome()
    await connectModel()
    act(() => spaceActions.create())
    await act(async () =>
      save.resolve((await original('endpoints.upsert', paramsOf('endpoints.upsert'))) as Endpoint),
    )
    expect(calls('dialog.pickFolder')).toHaveLength(0)
    expect(calls('session.create')).toHaveLength(0)
    expect(endpoints).toHaveLength(1)
  })

  it('focuses Message after history and metadata are ready, once', async () => {
    replayAutomatically = false
    const metadata = deferred<unknown>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'session.load' ? metadata.promise : original(method, params),
    )
    await welcome()
    await connectModel()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    expect(input).not.toHaveFocus()
    await act(async () => replayDone())
    expect(input).not.toHaveFocus()
    await act(async () =>
      metadata.resolve({ session: models.get('session-first'), activeTurnId: null }),
    )
    await vi.waitFor(() => expect(input).toHaveFocus())
    const elsewhere = screen.getByRole('button', { name: 'New space' })
    elsewhere.focus()
    await act(async () => replayDone())
    expect(elsewhere).toHaveFocus()
  })

  it('waits for complete history when metadata arrives before an empty replay chunk', async () => {
    replayAutomatically = false
    const metadata = deferred<unknown>()
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'session.load' ? metadata.promise : original(method, params),
    )
    await welcome()
    await connectModel()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    await act(async () =>
      metadata.resolve({ session: models.get('session-first'), activeTurnId: null }),
    )
    act(() => {
      replayListeners.get('session-first')?.({
        sessionId: 'session-first',
        replay: true,
        events: [],
      })
    })
    await settleFocus()
    expect(input).not.toHaveFocus()
    expect(
      screen.queryByRole('heading', { name: 'Make room for your next idea.' }),
    ).not.toBeInTheDocument()
    await act(async () => replayDone())
    await vi.waitFor(() => expect(input).toHaveFocus())
  })

  it.each(['replay', 'buffered live'] as const)(
    'does not hand off focus when complete history contains a %s message',
    async (delivery) => {
      replayAutomatically = false
      await welcome()
      await connectModel()
      const input = await screen.findByRole('textbox', { name: 'Message' })
      const event = {
        seq: 1,
        at: 1,
        sessionId: 'session-first',
        type: 'user.message.added',
        message: {
          id: 'message-before-ready',
          sessionId: 'session-first',
          turnId: 'turn-before-ready',
          role: 'user',
          parts: [{ type: 'text', text: 'A prompt before readiness' }],
          createdAt: 1,
        },
      }
      act(() => {
        const listener = replayListeners.get('session-first')
        listener?.({ sessionId: 'session-first', replay: true, events: [] })
        listener?.({
          sessionId: 'session-first',
          ...(delivery === 'replay' ? { replay: true, events: [event] } : { event }),
        })
        replayDone()
      })
      expect(await screen.findByText('A prompt before readiness')).toBeVisible()
      await settleFocus()
      expect(input).not.toHaveFocus()
      expect(
        screen.queryByRole('heading', { name: 'Make room for your next idea.' }),
      ).not.toBeInTheDocument()
    },
  )

  it.each(['rejected', 'missing'] as const)(
    'does not announce readiness when session metadata is %s',
    async (result) => {
      replayAutomatically = false
      const metadata = deferred<unknown>()
      const original = rpcMocks.invoke.getMockImplementation()!
      rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
        method === 'session.load' ? metadata.promise : original(method, params),
      )
      await welcome()
      await connectModel()
      const input = await screen.findByRole('textbox', { name: 'Message' })
      await act(async () => {
        if (result === 'rejected') metadata.reject(new Error('Metadata unavailable'))
        else metadata.resolve(null)
        replayDone()
      })
      await screen.findByRole('heading', { name: 'Make room for your next idea.' })
      await settleFocus()
      expect(input).not.toHaveFocus()
      expect(calls('session.create')).toHaveLength(1)
    },
  )

  it('does not hand off focus when successful metadata keeps the composer running', async () => {
    const original = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'session.load'
        ? Promise.resolve({ session: models.get('session-first'), activeTurnId: 'running-turn' })
        : original(method, params),
    )
    await welcome()
    await connectModel()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    await screen.findByRole('button', { name: 'Stop' })
    await settleFocus()
    expect(input).not.toHaveFocus()
    expect(
      screen.queryByRole('heading', { name: 'Make room for your next idea.' }),
    ).not.toBeInTheDocument()
  })

  it('hands focus to an explicitly reused empty session', async () => {
    projects = [PROJECT]
    recordSession({
      projectId: PROJECT.id,
      title: 'New session',
      driverKind: 'ari-core',
      modelId: null,
      permissionMode: 'ask',
      effort: null,
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('button', { name: 'Start a new session' })
    await user.keyboard('{Control>}n{/Control}')
    await screen.findByRole('textbox', { name: 'Search projects' })
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())
    expect(calls('session.create')).toHaveLength(0)
  })

  it('keeps the active empty session’s chosen model when explicitly starting it again', async () => {
    projects = [PROJECT]
    recordSession({
      projectId: PROJECT.id,
      title: 'Existing session',
      driverKind: 'ari-core',
      modelId: 'kept-model',
      permissionMode: 'ask',
    })
    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByText('Existing session'))
    await screen.findByRole('button', { name: 'Model: Ari Core · kept-model' })
    await user.keyboard('{Control>}n{/Control}')
    await screen.findByRole('textbox', { name: 'Search projects' })
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Model: Ari Core · kept-model' })).toBeInTheDocument()
    expect(calls('command.dispatch')).toHaveLength(0)
    expect(calls('session.create')).toHaveLength(0)
  })

  it('does not revive a handoff after deliberate focus elsewhere returns to the body', async () => {
    replayAutomatically = false
    await welcome()
    await connectModel()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    act(() => {
      const other = screen.getByRole('button', { name: 'New space' })
      other.focus()
      other.blur()
    })
    await act(async () => replayDone())
    await screen.findByRole('heading', { name: 'Make room for your next idea.' })
    expect(input).not.toHaveFocus()
  })

  it('does not revive a handoff after leaving and returning to its space', async () => {
    replayAutomatically = false
    await welcome()
    await connectModel()
    await screen.findByRole('textbox', { name: 'Message' })
    act(() => spaceActions.create())
    act(() => spaceActions.selectAt(0))
    await act(async () => replayDone())
    await screen.findByRole('heading', { name: 'Make room for your next idea.' })
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toHaveFocus()
  })

  it.each(['space', 'pane', 'session'] as const)(
    'does not select a late creation after the %s changes',
    async (change) => {
      const creation = deferred<{ sessionId: string }>()
      const original = rpcMocks.invoke.getMockImplementation()!
      rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
        method === 'session.create' ? creation.promise : original(method, params),
      )
      await welcome()
      await connectModel()
      act(() => {
        if (change === 'space') spaceActions.create()
        if (change === 'pane')
          splitLayoutActions.split(splitLayoutSnapshot().focusedPaneId, 'right')
        if (change === 'session') {
          recordSession(
            {
              projectId: PROJECT.id,
              title: 'Other session',
              driverKind: 'ari-core',
              modelId: null,
              permissionMode: 'ask',
            },
            'session-other',
          )
          splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'session-other')
        }
      })
      const before = splitLayoutSnapshot()
      await act(async () =>
        creation.resolve(recordSession(paramsOf('session.create') as SessionCreateParams)),
      )
      await vi.waitFor(() => expect(calls('session.list').length).toBeGreaterThan(1))
      expect(activeSessionOf(splitLayoutSnapshot())).toBe(activeSessionOf(before))
    },
  )

  it.each(['button', 'terminal', 'dialog'] as const)(
    'respects %s ownership while the composer becomes ready',
    async (owner) => {
      replayAutomatically = false
      await welcome()
      await connectModel()
      const input = await screen.findByRole('textbox', { name: 'Message' })
      let elsewhere: HTMLElement
      if (owner === 'terminal') {
        const terminal = document.createElement('div')
        terminal.className = 'xterm'
        elsewhere = document.createElement('textarea')
        terminal.append(elsewhere)
        document.body.append(terminal)
      } else if (owner === 'dialog') {
        const user = userEvent.setup()
        await user.keyboard('{Control>}k{/Control}')
        elsewhere = await screen.findByRole('textbox', { name: /Search commands/ })
      } else elsewhere = screen.getByRole('button', { name: 'New space' })
      act(() => elsewhere.focus())
      await act(async () => replayDone())
      await screen.findByRole('heading', { name: 'Make room for your next idea.' })
      expect(input).not.toHaveFocus()
      expect(elsewhere).toHaveFocus()
      if (owner === 'terminal') elsewhere.parentElement?.remove()
    },
  )

  it('does not autofocus ordinary existing-session selection', async () => {
    projects = [PROJECT]
    recordSession({
      projectId: PROJECT.id,
      title: 'Existing session',
      driverKind: 'ari-core',
      modelId: null,
      permissionMode: 'ask',
    })
    render(<App />)
    const user = userEvent.setup()
    const existing = await screen.findByText('Existing session')
    await user.click(existing)
    await screen.findByRole('heading', { name: 'Make room for your next idea.' })
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toHaveFocus()
  })
})

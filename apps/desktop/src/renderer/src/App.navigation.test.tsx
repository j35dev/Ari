import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { settingsSchema } from '@ari/contracts/settings'
import type {
  AppOpenFrame,
  AppOpenReceipt,
  AppOpenTarget,
  SessionSummary,
} from '@ari/contracts/rpc'
import type { OnboardingWorkspaceProps } from './features/onboarding/OnboardingGate'
import { App } from './App'
import { Composer } from './features/composer/Composer'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { activeSessionOf } from './features/split/split-layout'
import {
  machineFixture,
  snapshotFixture,
  catalogFixture,
} from './features/machines/fixtures.test-support'
import { dropDraftTextMemory } from './features/composer/use-drafts'
import {
  dropDraftIntentMemory,
  readSessionDraftIntent,
} from './features/composer/draft-recovery-store'

const { invoke, subscribe } = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('./lib/rpc', () => ({ rpc: { invoke, subscribe } }))
vi.mock('./features/onboarding/OnboardingGate', () => ({
  OnboardingGate: ({ children }: { children: (props: OnboardingWorkspaceProps) => ReactNode }) =>
    children({ onOpenSetup: () => undefined, setupCovered: false, onboardingOutcome: null }),
}))
vi.mock('./features/session/SessionView', () => ({
  SessionView: ({ sessionId, hidden }: { sessionId: string; hidden: boolean }) => (
    <div hidden={hidden} data-testid={`chat-${sessionId}`}>
      <span>Chat {sessionId}</span>
      <Composer
        sessionId={sessionId}
        onSend={() => {
          throw new Error('navigation submitted draft')
        }}
      />
    </div>
  ),
}))
vi.mock('./features/focus', () => ({ FocusPill: () => null }))
vi.mock('./features/usage/ProviderUsagePill', () => ({ ProviderUsagePill: () => null }))
vi.mock('./features/changes', () => ({
  ChangesView: ({
    projectId,
    sessionId,
    onRange,
  }: {
    projectId: string
    sessionId: string
    onRange?: unknown
  }) => (
    <div data-testid="changes">
      Changes {projectId}/{sessionId ?? 'project'} range:{String(Boolean(onRange))}
    </div>
  ),
}))
vi.mock('./features/changes/use-source-control', () => ({
  useSourceControl: () => ({ summary: null }),
}))
let callbacks: Map<string, { params: Record<string, unknown>; callback: (raw: unknown) => void }[]>
let sessions: SessionSummary[]
let settings: ReturnType<typeof settingsSchema.parse>
let sequence: number
let validate: (params: unknown) => Promise<unknown>
const project = { id: 'p', name: 'P', path: '/project', status: 'ok', open: true, createdAt: 1 }
beforeEach(() => {
  localStorage.clear()
  splitLayoutActions.reset()
  dropDraftTextMemory()
  dropDraftIntentMemory()
  splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'a')
  sessions = ['a', 'b', 'aria'].map((id) => ({
    id,
    projectId: id === 'aria' ? 'helm' : 'p',
    title: id,
    messageCount: 1,
    updatedAt: 1,
  }))
  settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
  callbacks = new Map()
  sequence = 0
  validate = async () => ({ allowed: true })
  subscribe.mockReset()
  invoke.mockReset()
  subscribe.mockImplementation(
    (name: string, params: Record<string, unknown>, callback: (raw: unknown) => void) => {
      const list = callbacks.get(name) ?? []
      const entry = { params, callback }
      list.push(entry)
      callbacks.set(name, list)
      return () =>
        callbacks.set(
          name,
          list.filter((item) => item !== entry),
        )
    },
  )
  invoke.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'ping':
        return 'pong'
      case 'app.info':
        return { platform: 'win32', homeDir: '/home', version: 'test' }
      case 'theme.apply':
        return { applied: true }
      case 'settings.get':
        return settings
      case 'session.list':
        return sessions
      case 'project.list':
        return [project]
      case 'session.workspace':
        return { path: '/project' }
      case 'aria.open':
        return { sessionId: 'aria' }
      case 'app.navigation.consumer':
        return { registered: true }
      case 'app.navigation.ack':
        return { acknowledged: true }
      case 'app.navigation.validate':
        return validate(params)
      case 'providers.detect':
      case 'providers.models':
      case 'endpoints.list':
        return []
      case 'files.index':
        return { paths: [] }
      default:
        throw new Error(`Unexpected RPC ${method}`)
    }
  })
})
afterEach(cleanup)
it('keeps remote workspace actions and keyboard shortcuts away from local dispatch and filesystem tools', async () => {
  const base = invoke.getMockImplementation()!
  const host = machineFixture()
  invoke.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'machines.list') return [host]
    if (method === 'machines.command') return { ok: true, result: { accepted: true } }
    if (method === 'machines.query') {
      const request = params as { query: { op: string } }
      if (request.query.op === 'session.get') return { ok: true, result: snapshotFixture() }
      if (request.query.op === 'project.list')
        return { ok: true, result: [{ id: 'same-project', name: 'Host project', sessionCount: 1 }] }
      if (request.query.op === 'session.list')
        return { ok: true, result: [snapshotFixture().summary] }
      if (request.query.op === 'models.list') return { ok: true, result: catalogFixture }
    }
    return base(method, params)
  })
  await shell()
  fireEvent.click(await screen.findByRole('button', { name: 'Remote task' }))
  await screen.findByRole('textbox', { name: 'Prompt on Studio computer' })
  const previous = invoke.mock.calls.length
  fireEvent.keyDown(window, { ctrlKey: true, key: '`' })
  fireEvent.keyDown(window, { ctrlKey: true, key: 'k' })
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([method, params]) =>
          method === 'machines.command' &&
          params.machineId === 'host-a' &&
          params.command.op === 'session.interrupt',
      ),
    ).toBe(true),
  )
  expect(
    invoke.mock.calls
      .slice(previous)
      .some(
        ([method]) =>
          method === 'command.dispatch' ||
          method.startsWith('fs.') ||
          method.startsWith('terminal.'),
      ),
  ).toBe(false)
  fireEvent.keyDown(window, { ctrlKey: true, key: 'n' })
  await screen.findByRole('heading', { name: 'New session on Studio computer' })
})
async function shell() {
  const view = render(<App />)
  await screen.findByText('Chat a')
  await waitFor(() =>
    expect(callbacks.get('app.navigate')?.some((entry) => entry.params.navigationConsumerId)).toBe(
      true,
    ),
  )
  return view
}
function send(target: AppOpenTarget, extras: Partial<AppOpenFrame> = {}): AppOpenFrame {
  const entry = callbacks.get('app.navigate')!.find((entry) => entry.params.navigationConsumerId)!
  const frame: AppOpenFrame = {
    kind: 'app.open',
    requestId: `r${++sequence}`,
    consumerId: String(entry.params.navigationConsumerId),
    target,
    expiresAt: Date.now() + 60_000,
    ...extras,
  }
  act(() => entry.callback(frame))
  return frame
}
async function acknowledged(frame: AppOpenFrame): Promise<AppOpenReceipt> {
  await waitFor(() =>
    expect(
      invoke.mock.calls.some(
        ([name, params]) =>
          name === 'app.navigation.ack' && params.receipt.requestId === frame.requestId,
      ),
    ).toBe(true),
  )
  return invoke.mock.calls.find(
    ([name, params]) =>
      name === 'app.navigation.ack' && params.receipt.requestId === frame.requestId,
  )![1].receipt as AppOpenReceipt
}

it('accepts navigation after earlier composer input when fresh list state commits', async () => {
  await shell()
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.pointerDown(input)
  fireEvent.keyDown(input, { key: 'a' })
  fireEvent.change(input, { target: { value: 'keep this unsent draft' } })
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (method, params) =>
    method === 'session.list' ? [...sessions] : original(method, params),
  )
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  validate = async () => {
    entered()
    await gate
    return { allowed: true }
  }
  const frame = send({ view: 'session', sessionId: 'b' })
  await act(async () => {
    await started
  })
  await act(async () => release())
  expect(await acknowledged(frame)).toMatchObject({ status: 'applied' })
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('b')
})

it('observes exact session/Aria selection and repeated reveal without discovery or submissions', async () => {
  await shell()
  const discoveryCount = invoke.mock.calls.filter(([name]) => name === 'providers.detect').length
  for (const target of [
    { view: 'session', sessionId: 'b' },
    { view: 'aria', sessionId: 'aria' },
    { view: 'session', sessionId: 'a' },
    { view: 'session', sessionId: 'a' },
  ] as const) {
    const frame = send(target)
    expect(await acknowledged(frame)).toMatchObject({
      status: 'applied',
      target,
      observed: { target, mode: 'chat' },
    })
    expect(activeSessionOf(splitLayoutSnapshot())).toBe(target.sessionId)
    expect(screen.getByTestId(`chat-${target.sessionId}`)).toBeVisible()
  }
  expect(invoke.mock.calls.filter(([name]) => name === 'providers.detect')).toHaveLength(
    discoveryCount,
  )
  expect(
    invoke.mock.calls.some(([name]) =>
      ['aria.open', 'aria.newChat', 'session.create', 'command.dispatch'].includes(name),
    ),
  ).toBe(false)
})

it('keeps real composer text, selection, pending attachment identity and chat through Settings and Changes', async () => {
  await shell()
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'unsent original draft' } })
  input.setSelectionRange(3, 7)
  fireEvent.paste(input, {
    clipboardData: { files: [new File(['image'], 'draft.png', { type: 'image/png' })] },
  })
  const before = readSessionDraftIntent('a')
  const opened = send({ view: 'settings' })
  expect(await acknowledged(opened)).toMatchObject({
    status: 'applied',
    observed: { mode: 'settings' },
  })
  expect(await screen.findByRole('button', { name: 'Back' })).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('a')
  const changes = send({ view: 'changes', projectId: 'p', sessionId: 'b' })
  expect(await acknowledged(changes)).toMatchObject({
    status: 'applied',
    observed: { mode: 'page' },
  })
  expect(screen.getByTestId('changes')).toHaveTextContent('Changes p/b range:false')
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('a')
  const back = send({ view: 'session', sessionId: 'a' })
  expect(await acknowledged(back)).toMatchObject({ status: 'applied' })
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('unsent original draft')
  expect(readSessionDraftIntent('a').images).toEqual(before.images)
  expect(
    (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).selectionStart,
  ).toBe(3)
  expect(invoke.mock.calls.some(([name]) => name === 'command.dispatch')).toBe(false)
})

it('honors Changes sidebar mode and exact project context without changing the chat', async () => {
  settings = settingsSchema.parse({
    ...settings,
    sourceControl: { ...settings.sourceControl, diffOpenMode: 'sidebar' },
  })
  await shell()
  expect(await acknowledged(send({ view: 'changes', projectId: 'p' }))).toMatchObject({
    status: 'applied',
    observed: { mode: 'sidebar' },
  })
  expect(screen.getByTestId('changes')).toHaveTextContent('Changes p/project range:false')
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('a')
})

it('keeps a newer app action above an older manual Aria lookup', async () => {
  sessions = sessions.filter((session) => session.id !== 'aria')
  await shell()
  let complete!: (value: unknown) => void
  let entered!: () => void
  const started = new Promise<void>((done) => {
    entered = done
  })
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (method, params) =>
    method === 'aria.open'
      ? (entered(),
        new Promise((done) => {
          complete = done
        }))
      : original(method, params),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open Aria' }))
  await act(async () => {
    await started
  })
  expect(await acknowledged(send({ view: 'settings' }))).toMatchObject({ status: 'applied' })
  await act(async () => {
    sessions = [
      ...sessions,
      { id: 'manual-aria', projectId: 'helm', title: 'Aria', messageCount: 0, updatedAt: 2 },
    ]
    complete({ sessionId: 'manual-aria' })
  })
  expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('a')
})

it('refuses failed, disconnected, missing or archived loads without redirecting', async () => {
  await shell()
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (method, params) =>
    method === 'session.list'
      ? Promise.reject(new Error('load disconnected'))
      : original(method, params),
  )
  expect(await acknowledged(send({ view: 'session', sessionId: 'b' }))).toMatchObject({
    status: 'failed',
    reason: 'load_failed',
  })
  invoke.mockImplementation(original)
  sessions = sessions.map((session) =>
    session.id === 'b' ? { ...session, archived: true } : session,
  )
  expect(await acknowledged(send({ view: 'session', sessionId: 'b' }))).toMatchObject({
    status: 'stale',
    reason: 'target_changed',
  })
  expect(await acknowledged(send({ view: 'session', sessionId: 'missing' }))).toMatchObject({
    status: 'stale',
  })
  validate = async () => {
    throw new Error('main disconnected')
  }
  expect(await acknowledged(send({ view: 'settings' }))).toMatchObject({
    status: 'failed',
    reason: 'load_failed',
  })
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('a')
})

it('lets newer user navigation win over delayed validation and cancels duplicate/wrong/late frames', async () => {
  const view = await shell()
  let release!: (value: unknown) => void
  let entered!: () => void
  const start = new Promise<void>((done) => {
    entered = done
  })
  validate = () => {
    entered()
    return new Promise((done) => {
      release = done
    })
  }
  const pending = send({ view: 'session', sessionId: 'b' })
  await act(async () => {
    await start
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open Aria' }))
  expect(await acknowledged(pending)).toMatchObject({
    status: 'superseded',
    reason: 'user_navigation',
  })
  await act(async () => {
    release({ allowed: true })
  })
  expect(await screen.findByText('Chat aria')).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('aria')
  const entry = callbacks.get('app.navigate')!.find((entry) => entry.params.navigationConsumerId)!
  act(() => {
    entry.callback(pending)
    entry.callback({ ...pending, requestId: 'wrong', consumerId: 'other' })
    entry.callback({ ...pending, requestId: 'bad', expiresAt: 'invalid' })
  })
  expect(
    invoke.mock.calls.filter(
      ([name, params]) =>
        name === 'app.navigation.ack' && params.receipt.requestId === pending.requestId,
    ),
  ).toHaveLength(1)
  expect(await acknowledged(send({ view: 'settings' }, { expiresAt: 1 }))).toMatchObject({
    status: 'stale',
    reason: 'expired',
  })
  const cancel = send({ view: 'session', sessionId: 'b' })
  act(() =>
    entry.callback({
      kind: 'app.open.cancel',
      consumerId: cancel.consumerId,
      requestId: cancel.requestId,
    }),
  )
  view.unmount()
  await act(async () => {
    release({ allowed: true })
  })
  expect(
    invoke.mock.calls.some(
      ([name, params]) =>
        name === 'app.navigation.ack' && params.receipt.requestId === cancel.requestId,
    ),
  ).toBe(false)
})

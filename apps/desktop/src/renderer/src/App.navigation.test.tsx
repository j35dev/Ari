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
import {
  SessionClientProvider,
  sessionViewKey,
  useSessionClient,
  type SessionScope,
} from './features/session/session-client'
import { keepAliveActions } from './features/session/session-keep-alive'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { activeSessionOf } from './features/split/split-layout'
import {
  desktopMachineFixture,
  snapshotFixture,
  localSnapshotFixture,
  projectCatalogFixture,
  versionFixture,
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
  SessionView: ({ scope, hidden }: { scope: SessionScope; hidden: boolean }) => (
    <SessionClientProvider scope={scope}>
      <NavigationSessionView hidden={hidden} />
    </SessionClientProvider>
  ),
}))
function NavigationSessionView({ hidden }: { hidden: boolean }) {
  const client = useSessionClient()
  return (
    <div hidden={hidden} data-testid={`chat-${client.viewKey}`}>
      <span>Chat {client.viewKey}</span>
      <Composer
        sessionId={client.viewKey}
        onSend={() => {
          throw new Error('navigation submitted draft')
        }}
      />
      {client.scope.kind === 'remote' && (
        <>
          <button
            onClick={() =>
              void client.invoke('command.dispatch', {
                command: { type: 'turn.interrupt', sessionId: client.scope.sessionId },
              })
            }
          >
            Stop
          </button>
          <button
            onClick={() =>
              void client.invoke('fs.readTextFile', {
                sessionId: client.scope.sessionId,
                path: 'README.md',
              })
            }
          >
            Read host file
          </button>
        </>
      )}
    </div>
  )
}
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
  keepAliveActions.reset()
  dropDraftTextMemory()
  dropDraftIntentMemory()
  splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sess_a')
  sessions = ['sess_a', 'sess_b', 'sess_aria'].map((id) => ({
    id,
    projectId: id === 'sess_aria' ? 'helm' : 'p',
    title: id.replace('sess_', ''),
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
      case 'machines.list':
        return []
      case 'machines.preferences':
        return { autoEnabled: false, hostTiers: {}, projectHosts: {} }
      case 'machines.localSnapshot': {
        const snapshot = localSnapshotFixture()
        snapshot.catalog.projects = [
          {
            id: project.id,
            name: project.name,
            sessionCount: sessions.filter((session) => session.projectId === project.id).length,
            status: 'ok',
            defaultAgent: null,
            repositoryIdentity: null,
          },
        ]
        snapshot.models.defaults = {
          ...snapshot.models.defaults,
          driverKind: settings.sessions.defaultDriverKind,
          configuredDriverKind: settings.sessions.defaultDriverKind,
          modelId: null,
          permissionMode: settings.sessions.defaultPermissionMode,
        }
        return snapshot
      }
      case 'session.workspace':
        return { path: '/project' }
      case 'aria.open':
        return { sessionId: 'sess_aria' }
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
it('routes normal remote session actions and file reads to their host without local dispatch', async () => {
  const base = invoke.getMockImplementation()!
  const host = desktopMachineFixture()
  const remote = snapshotFixture('sess_a')
  const remoteKey = sessionViewKey({
    kind: 'remote',
    machineId: host.id,
    sessionId: remote.summary.id,
  })
  invoke.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'machines.list') return [host]
    if (method === 'machines.command') return { ok: true, result: { accepted: true } }
    if (method === 'machines.query') {
      const request = params as { machineId: string; query: { op: string } }
      expect(request.machineId).toBe(host.id)
      switch (request.query.op) {
        case 'project.catalog':
          return { ok: true, result: projectCatalogFixture() }
        case 'session.list':
          return { ok: true, result: [remote.summary] }
        case 'models.list':
          return { ok: true, result: catalogFixture }
        case 'host.permissions':
          return {
            ok: true,
            result: {
              deviceId: 'device',
              projectScope: { kind: 'all' },
              allowTerminal: false,
              managedLeaseExpiresAt: null,
            },
          }
        case 'host.version':
          return { ok: true, result: versionFixture }
        case 'files.read':
          return {
            ok: true,
            result: {
              path: 'README.md',
              kind: 'text',
              size: 11,
              content: 'Host README',
              error: null,
            },
          }
      }
    }
    return base(method, params)
  })
  await shell()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'Local unsent draft' },
  })
  fireEvent.click(await screen.findByRole('button', { name: /^Remote task/ }))
  expect(await screen.findByTestId(`chat-${remoteKey}`)).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe(remoteKey)
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'Host unsent draft' },
  })
  const previous = invoke.mock.calls.length
  fireEvent.keyDown(window, { ctrlKey: true, key: '`' })
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  fireEvent.click(screen.getByRole('button', { name: 'Read host file' }))
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith(
      'machines.command',
      expect.objectContaining({
        machineId: host.id,
        command: expect.objectContaining({ op: 'session.interrupt', sessionId: remote.summary.id }),
      }),
    )
    expect(invoke).toHaveBeenCalledWith('machines.query', {
      machineId: host.id,
      query: { op: 'files.read', sessionId: remote.summary.id, path: 'README.md' },
    })
  })
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
  const frame = send({ view: 'session', sessionId: 'sess_a' })
  expect(await acknowledged(frame)).toMatchObject({ status: 'applied' })
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Local unsent draft')
  fireEvent.click(screen.getByRole('button', { name: /^Remote task/ }))
  expect(await screen.findByTestId(`chat-${remoteKey}`)).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Host unsent draft')
})
async function shell() {
  const view = render(<App />)
  await screen.findByText('Chat sess_a')
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
  const frame = send({ view: 'session', sessionId: 'sess_b' })
  await act(async () => {
    await started
  })
  await act(async () => release())
  expect(await acknowledged(frame)).toMatchObject({ status: 'applied' })
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_b')
})

it('observes exact session/Aria selection and repeated reveal without discovery or submissions', async () => {
  await shell()
  const discoveryCount = invoke.mock.calls.filter(([name]) => name === 'providers.detect').length
  for (const target of [
    { view: 'session', sessionId: 'sess_b' },
    { view: 'aria', sessionId: 'sess_aria' },
    { view: 'session', sessionId: 'sess_a' },
    { view: 'session', sessionId: 'sess_a' },
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
  const before = readSessionDraftIntent('sess_a')
  const opened = send({ view: 'settings' })
  expect(await acknowledged(opened)).toMatchObject({
    status: 'applied',
    observed: { mode: 'settings' },
  })
  expect(await screen.findByRole('button', { name: 'Close settings' })).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_a')
  const changes = send({ view: 'changes', projectId: 'p', sessionId: 'sess_b' })
  expect(await acknowledged(changes)).toMatchObject({
    status: 'applied',
    observed: { mode: 'page' },
  })
  expect(screen.getByTestId('changes')).toHaveTextContent('Changes p/sess_b range:false')
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_a')
  const back = send({ view: 'session', sessionId: 'sess_a' })
  expect(await acknowledged(back)).toMatchObject({ status: 'applied' })
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('unsent original draft')
  expect(readSessionDraftIntent('sess_a').images).toEqual(before.images)
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
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_a')
})

it('keeps a newer app action above an older manual Aria lookup', async () => {
  sessions = sessions.filter((session) => session.id !== 'sess_aria')
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
      { id: 'sess_manual_aria', projectId: 'helm', title: 'Aria', messageCount: 0, updatedAt: 2 },
    ]
    complete({ sessionId: 'sess_manual_aria' })
  })
  expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_a')
})

it('refuses failed, disconnected, missing or archived loads without redirecting', async () => {
  await shell()
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (method, params) =>
    method === 'session.list'
      ? Promise.reject(new Error('load disconnected'))
      : original(method, params),
  )
  expect(await acknowledged(send({ view: 'session', sessionId: 'sess_b' }))).toMatchObject({
    status: 'failed',
    reason: 'load_failed',
  })
  invoke.mockImplementation(original)
  sessions = sessions.map((session) =>
    session.id === 'sess_b' ? { ...session, archived: true } : session,
  )
  expect(await acknowledged(send({ view: 'session', sessionId: 'sess_b' }))).toMatchObject({
    status: 'stale',
    reason: 'target_changed',
  })
  expect(await acknowledged(send({ view: 'session', sessionId: 'sess_missing' }))).toMatchObject({
    status: 'stale',
  })
  validate = async () => {
    throw new Error('main disconnected')
  }
  expect(await acknowledged(send({ view: 'settings' }))).toMatchObject({
    status: 'failed',
    reason: 'load_failed',
  })
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_a')
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
  const pending = send({ view: 'session', sessionId: 'sess_b' })
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
  expect(await screen.findByText('Chat sess_aria')).toBeVisible()
  expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_aria')
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
  const cancel = send({ view: 'session', sessionId: 'sess_b' })
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

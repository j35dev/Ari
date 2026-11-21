import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import type { SessionCreateParams, SessionSummary } from '@ari/contracts/rpc'
import { settingsSchema } from '@ari/contracts/settings'
import type { OnboardingWorkspaceProps } from './features/onboarding/OnboardingGate'
import { localSnapshotFixture } from './features/machines/fixtures.test-support'
import { App } from './App'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { activeSessionOf } from './features/split/split-layout'
import { spaceActions } from './features/spaces'
import { keepAliveActions } from './features/session/session-keep-alive'
import { dropDraftIntentMemory } from './features/composer/draft-recovery-store'
import { DRAFTS_STORAGE_KEY, dropDraftTextMemory, readSessionDraftText } from './features/composer/use-drafts'
import { readProjectDrafts } from './features/machines/project-draft-registry'

const rpc = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => {}) }))
vi.mock('./lib/rpc', () => ({ rpc }))
vi.mock('./features/focus/FocusPill', () => ({ FocusPill: () => null }))
vi.mock('./features/onboarding/OnboardingGate', () => ({
  OnboardingGate: ({ children }: { children: (props: OnboardingWorkspaceProps) => ReactNode }) =>
    children({ onOpenSetup: () => {}, setupCovered: false, onboardingOutcome: null, onLanded: () => undefined }),
}))
vi.mock('./features/session/SessionView', () => ({ SessionView: ({ sessionId, scope, defaults }: {
  sessionId: string; scope?: { kind: string }; defaults?: { driverKind: string; modelId: string | null }
}) => <output data-testid="normal-session" data-model={`${defaults?.driverKind}:${defaults?.modelId}`}>{scope?.kind}:{sessionId}</output> }))
vi.mock('./features/speech/useSpeech', () => ({ useSpeech: () => ({ status: { ready: false } }) }))

const PROJECT: Project = { id: 'project-first', name: 'First project', path: 'D:/fixture/project',
  colorIndex: 0, createdAt: 1, lastOpenedAt: 1, status: 'ok', open: true }
let projects: Project[]
let sessions: SessionSummary[]
let endpoints: Array<{ id: string }>
const calls = (method: string) => rpc.invoke.mock.calls.filter(([name]) => name === method)
const record = (params: SessionCreateParams, id = 'sess_first') => {
  sessions.push({ id, projectId: params.projectId, title: params.title, messageCount: 0, updatedAt: 2 })
  return { sessionId: id }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  localStorage.clear(); dropDraftIntentMemory(); dropDraftTextMemory()
  splitLayoutActions.reset(); keepAliveActions.reset()
  projects = [PROJECT]; sessions = []; endpoints = []
  rpc.invoke.mockReset(); rpc.subscribe.mockClear()
  rpc.invoke.mockImplementation(async (method: string, raw?: unknown) => {
    if (method === 'ping') return 'pong'
    if (method === 'app.info') return { homeDir: 'D:/fixture' }
    if (method === 'settings.get') return settingsSchema.parse({ version: 1, appearance: { reducedMotion: true } })
    if (method === 'machines.list') return []
    if (method === 'machines.preferences') return { autoEnabled: false, hostTiers: {}, projectHosts: {} }
    if (method === 'machines.localSnapshot') {
      const snapshot = localSnapshotFixture()
      snapshot.catalog.projects = [{ id: PROJECT.id, name: PROJECT.name, sessionCount: sessions.length,
        status: 'ok', defaultAgent: null, repositoryIdentity: null }]
      snapshot.models.providers = [{ driverKind: 'ari-core', available: true,
        models: [{ id: 'default', label: 'Host default' }, ...endpoints.map((endpoint) => ({ id: `ep:${endpoint.id}`, label: 'Saved model' }))],
        modes: (['ask', 'allow-edits', 'full'] as const).map((ariMode) => ({ id: ariMode, label: ariMode, ariMode })) }]
      return snapshot
    }
    if (method === 'project.list') return projects
    if (method === 'session.list') return sessions.slice()
    if (method === 'endpoints.list') return endpoints
    if (method === 'endpoints.upsert') { endpoints = [raw as { id: string }]; return raw }
    if (method === 'providers.detect' || method === 'providers.models' || method === 'providers.efforts') return []
    if (method === 'session.workspace') return { path: PROJECT.path }
    if (method === 'dialog.pickFolder') return { path: PROJECT.path }
    if (method === 'project.open') { projects = [PROJECT]; return PROJECT }
    if (method === 'session.create') return record(raw as SessionCreateParams)
    if (method === 'command.dispatch') return { accepted: true }
    if (method === 'session.load') return { session: null, activeTurnId: null }
    throw new Error(`Unexpected fixture RPC ${method}`)
  })
})
async function chooseDraft() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'New session' }))
  const chooser = await screen.findByRole('dialog', { name: 'New session' })
  await user.click(await within(chooser).findByRole('option', { name: 'First project' }))
  await screen.findByRole('button', { name: 'Execution machine' })
  await waitFor(() => expect(screen.queryByText('This agent is unavailable on the selected machine.')).toBeNull())
  return user
}
async function sendDraft(user: ReturnType<typeof userEvent.setup>, text = 'First prompt') {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}
describe('first-send shell draft ownership', () => {
  it('brings back unsent text when a new session for the same project is opened again', async () => {
    render(<App />)
    const user = await chooseDraft()
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Half-written idea')
    await user.click(screen.getByRole('button', { name: 'Close draft' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close draft' })).toBeNull())
    await chooseDraft()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Half-written idea')
    expect(calls('session.create')).toHaveLength(0)
  })
  it('selects a client draft without creation, then delivers first Send once to a normal local scope', async () => {
    render(<App />)
    const user = await chooseDraft()
    expect(calls('session.create')).toHaveLength(0)
    expect(activeSessionOf(splitLayoutSnapshot())).toBeNull()
    // The draft names its project in the titlebar, as a session does.
    expect(screen.getByLabelText('Session project')).toHaveTextContent('First project')
    await sendDraft(user)
    expect(await screen.findByTestId('normal-session')).toHaveTextContent('local:sess_first')
    expect(calls('session.create')).toHaveLength(1)
    expect(calls('command.dispatch')).toEqual([['command.dispatch', { command: {
      type: 'turn.start', sessionId: 'sess_first', text: 'First prompt', attachments: [],
    } }]])
    expect(screen.queryByRole('button', { name: 'Execution machine' })).toBeNull()
  })
  it('opens the session after sending from a draft that replaced an earlier draft in the same pane', async () => {
    render(<App />)
    await chooseDraft()
    const user = await chooseDraft()
    await sendDraft(user)
    expect(await screen.findByTestId('normal-session')).toHaveTextContent('local:sess_first')
    expect(screen.queryByRole('button', { name: 'Execution machine' })).toBeNull()
  })
  it.each(['create', 'stage', 'prompt'] as const)('starts fresh instead of reopening a parked %s submission draft', async (phase) => {
    render(<App />)
    const user = await chooseDraft()
    const original = readProjectDrafts()[0]!
    const originalText = 'An old submission from another session'
    await user.type(screen.getByRole('textbox', { name: 'Message' }), originalText)
    const key = `ari.machines.projectDraft.attempt.v1:${original.id}`
    const receipt = JSON.stringify({ draftId: original.id, groupId: original.groupId,
      hostId: 'local', projectId: PROJECT.id, text: originalText, phase,
      scope: phase === 'create' ? null : { kind: 'local', sessionId: 'sess_old' } })
    localStorage.setItem(key, receipt)
    await user.click(screen.getByRole('button', { name: 'Close draft' }))

    await chooseDraft()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Check original submission' })).toBeNull()
    expect(readProjectDrafts().at(-1)?.id).not.toBe(original.id)
    expect(readProjectDrafts().find((entry) => entry.id === original.id)?.paneId).toBe(`parked:${original.id}`)
    expect(localStorage.getItem(key)).toBe(receipt)
    expect(readSessionDraftText(`project-draft:${original.id}`)).toBe(originalText)
    expect(calls('session.create')).toHaveLength(0)
    expect(calls('command.dispatch')).toHaveLength(0)

    await sendDraft(user, 'Only the fresh prompt')
    expect(await screen.findByTestId('normal-session')).toHaveTextContent('local:sess_first')
    expect(calls('command.dispatch')).toEqual([['command.dispatch', { command: {
      type: 'turn.start', sessionId: 'sess_first', text: 'Only the fresh prompt', attachments: [],
    } }]])
  })
  it('creates a fresh local session on Send even when an older empty session has a saved draft', async () => {
    record({ projectId: PROJECT.id, title: 'Empty session', driverKind: 'ari-core', modelId: null, permissionMode: 'ask' }, 'sess_empty')
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ sess_empty: 'An older unsent prompt' }))
    render(<App />)
    const user = await chooseDraft()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    await sendDraft(user)
    expect(await screen.findByTestId('normal-session')).toHaveTextContent('local:sess_first')
    expect(calls('session.create')).toHaveLength(1)
    expect(calls('command.dispatch')).toEqual([['command.dispatch', { command: {
      type: 'turn.start', sessionId: 'sess_first', text: 'First prompt', attachments: [],
    } }]])
    expect(readSessionDraftText('sess_empty')).toBe('An older unsent prompt')
  })
  it('frees the draft to send again once This PC shows the failed creation made no session', async () => {
    const base = rpc.invoke.getMockImplementation()!
    let lost = true
    rpc.invoke.mockImplementation((method, params) => method === 'session.create' && lost
      ? Promise.reject(new Error('Creation reply lost')) : base(method, params))
    render(<App />)
    const user = await chooseDraft()
    await sendDraft(user, 'Original uncertain text')
    await user.click(await screen.findByRole('button', { name: 'Check original submission' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Check original submission' })).toBeNull())
    expect(calls('session.create')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Original uncertain text')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    expect(calls('command.dispatch')).toHaveLength(0)
    // Nothing else holds the window's starts: the same text now goes through.
    lost = false
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByTestId('normal-session')).toHaveTextContent('local:sess_first')
    expect(calls('session.create')).toHaveLength(2)
  })
  it('lets an explicit new session start fresh after an earlier creation acknowledgement was lost', async () => {
    const base = rpc.invoke.getMockImplementation()!
    let creationCount = 0
    rpc.invoke.mockImplementation((method, params) => {
      if (method === 'session.create' && ++creationCount === 1) {
        record(params as SessionCreateParams, 'sess_unknown')
        return Promise.reject(new Error('Creation acknowledgement lost'))
      }
      return base(method, params)
    })
    render(<App />)
    const originalUser = await chooseDraft()
    const original = readProjectDrafts()[0]!
    await sendDraft(originalUser, 'Original uncertain prompt')
    await screen.findByRole('button', { name: 'Check original submission' })
    const key = `ari.machines.projectDraft.attempt.v1:${original.id}`
    const receipt = localStorage.getItem(key)
    expect(receipt).not.toBeNull()

    const user = await chooseDraft()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Check original submission' })).toBeNull()
    expect(screen.queryByText('Couldn’t confirm the new session')).toBeNull()
    expect(localStorage.getItem(key)).toBe(receipt)
    expect(readSessionDraftText(`project-draft:${original.id}`)).toBe('Original uncertain prompt')
    await sendDraft(user, 'Fresh prompt')
    expect(await screen.findByTestId('normal-session')).toHaveTextContent('local:sess_first')
    expect(calls('session.create')).toHaveLength(2)
    expect(calls('command.dispatch')).toEqual([['command.dispatch', { command: {
      type: 'turn.start', sessionId: 'sess_first', text: 'Fresh prompt', attachments: [],
    } }]])
  })
  it('keeps confirmed creation and unknown first prompt separate without recreating or resending', async () => {
    const base = rpc.invoke.getMockImplementation()!
    rpc.invoke.mockImplementation((method, params) => method === 'command.dispatch'
      ? Promise.reject(new Error('Prompt reply lost')) : base(method, params))
    render(<App />)
    const user = await chooseDraft()
    await sendDraft(user)
    await screen.findByRole('button', { name: 'Check original submission' })
    await user.click(screen.getByRole('button', { name: 'Check original submission' }))
    expect(calls('session.create')).toHaveLength(1); expect(calls('command.dispatch')).toHaveLength(1)
    expect(rpc.invoke).toHaveBeenCalledWith('session.load', { sessionId: 'sess_first' })
    expect(activeSessionOf(splitLayoutSnapshot())).toBeNull()
  })
  it.each(['space', 'session', 'park'] as const)('keeps late completion from replacing new %s ownership', async (change) => {
    const creation = deferred<{ sessionId: string }>()
    const base = rpc.invoke.getMockImplementation()!
    rpc.invoke.mockImplementation((method, params) => method === 'session.create' ? creation.promise : base(method, params))
    if (change === 'session') sessions.push({ id: 'sess_other', projectId: PROJECT.id, title: 'Other session', messageCount: 1, updatedAt: 1 })
    render(<App />)
    const user = await chooseDraft()
    await sendDraft(user)
    await waitFor(() => expect(calls('session.create')).toHaveLength(1))
    if (change === 'space') act(() => spaceActions.create())
    if (change === 'session') {
      await user.click(screen.getByText('Other session'))
    }
    if (change === 'park') await user.click(screen.getByRole('button', { name: 'Close draft' }))
    const before = activeSessionOf(splitLayoutSnapshot())
    await act(async () => creation.resolve(record(calls('session.create')[0]![1] as SessionCreateParams)))
    await waitFor(() => expect(calls('command.dispatch')).toHaveLength(1))
    expect(activeSessionOf(splitLayoutSnapshot())).toBe(before)
  })
  it('opens a project draft after saving a model, without creating a session from setup', async () => {
    projects = []
    render(<App />)
    const user = userEvent.setup()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Base URL' }), { target: { value: 'http://127.0.0.1:9/v1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Model id' }), { target: { value: 'first-model' } })
    await user.click(screen.getByRole('button', { name: 'Save and choose project' }))
    const chooser = await screen.findByRole('dialog', { name: 'New session' })
    await user.click(within(chooser).getByRole('button', { name: /Add project/ }))
    await screen.findByRole('button', { name: 'Execution machine' })
    expect(calls('endpoints.upsert')).toHaveLength(1); expect(calls('session.create')).toHaveLength(0)
    await sendDraft(user)
    await screen.findByTestId('normal-session')
    expect(calls('session.create')[0]?.[1]).toMatchObject({ modelId: `ep:${endpoints[0]!.id}` })
  })
})

describe('opening a listed session', () => {
  it('starts its composer on its own agent and model, not the app-wide pick', async () => {
    sessions.push({ id: 'sess_listed', projectId: PROJECT.id, title: 'Listed session', messageCount: 2,
      updatedAt: 1, driverKind: 'codex', modelId: 'gpt-6.1-sol', effort: 'high', permissionMode: 'full' })
    render(<App />)
    await userEvent.setup().click(await screen.findByText('Listed session'))
    expect(await screen.findByTestId('normal-session')).toHaveAttribute('data-model', 'codex:gpt-6.1-sol')
  })
})

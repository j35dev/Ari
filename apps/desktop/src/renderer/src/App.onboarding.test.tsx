import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsSchema, type Settings, type SettingsUpdate } from '@ari/contracts/settings'
import { projectViewSchema, type Project } from '@ari/contracts/project'
import type { SessionCreateParams, SessionSummary } from '@ari/contracts/rpc'
import { App } from './App'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { loadLastPick } from './features/composer/last-pick'
import { activeSessionOf } from './features/split/split-layout'
import type { SessionScope } from './features/session/session-client'
import { readProjectDrafts } from './features/machines/project-draft-registry'
import { localSnapshotFixture, desktopMachineFixture, projectCatalogFixture, catalogFixture, versionFixture } from './features/machines/fixtures.test-support'
import { spaceActions, spaceStoreSnapshot } from './features/spaces'
import { keepAliveActions } from './features/session/session-keep-alive'
import { dropDraftIntentMemory } from './features/composer/draft-recovery-store'
import { dropDraftTextMemory } from './features/composer/use-drafts'

const { invoke, subscribe } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('./lib/rpc', () => ({ rpc: { invoke, subscribe } }))
vi.mock('./features/session/SessionView', () => ({
  SessionView: ({
    sessionId,
    scope,
    hidden,
  }: {
    sessionId: string
    scope: SessionScope
    hidden: boolean
  }) => (
    <div hidden={hidden} data-scope={scope.kind}>
      Opened session {sessionId}
    </div>
  ),
}))
vi.mock('./features/focus', () => ({ FocusPill: () => null }))
vi.mock('./features/usage/ProviderUsagePill', () => ({ ProviderUsagePill: () => null }))
const project = projectViewSchema.parse({
  id: 'project-ari',
  name: 'Ari',
  path: '/work/Ari',
  status: 'ok',
  open: true,
  createdAt: 1,
})
let settings: Settings
let projects: Project[]
let sessions: SessionSummary[]
beforeEach(() => {
  localStorage.clear()
  splitLayoutActions.reset()
  keepAliveActions.reset()
  dropDraftIntentMemory()
  dropDraftTextMemory()
  settings = settingsSchema.parse({ version: 1 })
  projects = []
  sessions = []
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    switch (method) {
      case 'ping':
        return 'pong'
      case 'theme.apply':
        return { applied: true }
      case 'app.info':
        return { platform: 'win32', homeDir: '/home/test', version: '0.3.8' }
      case 'settings.get':
        return settings
      case 'settings.update': {
        const patch = params as SettingsUpdate
        settings = settingsSchema.parse({
          ...settings,
          ...patch,
          sessions: { ...settings.sessions, ...patch.sessions },
        })
        return settings
      }
      case 'project.list':
        return projects
      case 'machines.list':
        return []
      case 'machines.preferences':
        return { autoEnabled: false, hostTiers: {}, projectHosts: {} }
      case 'machines.localSnapshot': {
        const snapshot = localSnapshotFixture()
        snapshot.catalog.projects = projects.map((project) => ({
          id: project.id,
          name: project.name,
          sessionCount: sessions.filter((session) => session.projectId === project.id).length,
          status: 'ok',
          defaultAgent: null,
          repositoryIdentity: null,
        }))
        snapshot.models.defaults = {
          ...snapshot.models.defaults,
          driverKind: settings.sessions.defaultDriverKind,
          configuredDriverKind: settings.sessions.defaultDriverKind,
          modelId: null,
          permissionMode: settings.sessions.defaultPermissionMode,
        }
        snapshot.models.providers = [
          {
            driverKind: 'claude',
            available: true,
            models: [{ id: 'default', label: 'Claude default' }],
            modes: (['ask', 'allow-edits', 'full'] as const).map((ariMode) => ({
              id: ariMode,
              label: ariMode,
              ariMode,
            })),
          },
        ]
        return snapshot
      }
      case 'project.discover':
        return {
          projects: [
            { path: project.path, name: project.name, sources: ['claude'], lastUsedAt: 1 },
          ],
          truncated: false,
          warnings: [],
        }
      case 'project.open':
        projects = [project]
        return project
      case 'session.list':
        return sessions
      case 'aria.open': {
        const current = sessions.find(
          (session) => session.projectId === 'helm' && !session.archived,
        )
        if (current) return { sessionId: current.id }
        if (!sessions.some((session) => session.id === 'sess_aria'))
          sessions = [
            ...sessions,
            {
              id: 'sess_aria',
              projectId: 'helm',
              title: 'Aria',
              messageCount: 0,
              updatedAt: 1,
            },
          ]
        return { sessionId: 'sess_aria' }
      }
      case 'aria.newChat': {
        sessions = [
          ...sessions.filter((session) => session.id !== 'sess_aria'),
          {
            id: 'sess_fresh_aria',
            projectId: 'helm',
            title: 'Aria',
            messageCount: 0,
            updatedAt: 2,
          },
        ]
        return { sessionId: 'sess_fresh_aria' }
      }
      case 'session.create': {
        const input = params as SessionCreateParams
        sessions = [
          ...sessions,
          {
            id: 'sess_onboarded',
            projectId: input.projectId,
            title: input.title,
            messageCount: 0,
            updatedAt: 1,
          },
        ]
        return { sessionId: 'sess_onboarded' }
      }
      case 'session.workspace':
        return { path: project.path }
      case 'providers.detect':
        return [
          {
            kind: 'claude',
            installed: true,
            binaryPath: '/bin/claude',
            version: '2.1',
            authStatus: 'authenticated',
          },
        ]
      case 'command.dispatch':
        return { accepted: true }
      case 'providers.efforts':
      case 'providers.models':
      case 'endpoints.list':
        return []
      default:
        throw new Error(`Unexpected RPC: ${method}`)
    }
  })
})

async function finishFirstRun() {
  await screen.findByRole('heading', { name: 'Meet your coding agents.' })
  await screen.findByText('Sign-in found')
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: /Add Ari/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
}

describe('App onboarding integration', () => {
  it('waits for the complete host catalog before freezing the merged setup draft', async () => {
    const base = invoke.getMockImplementation()!
    const host = desktopMachineFixture()
    const remote = projectCatalogFixture()
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    let localArrived = false
    invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.list') return [host]
      if (method === 'machines.localSnapshot') {
        const snapshot = await base(method, params) as ReturnType<typeof localSnapshotFixture>
        snapshot.catalog.projects = snapshot.catalog.projects.map((entry) => ({ ...entry,
          repositoryIdentity: remote.projects[0]!.repositoryIdentity }))
        if (snapshot.catalog.projects.some((entry) => entry.id === project.id)) localArrived = true
        return snapshot
      }
      if (method === 'machines.query') {
        const op = (params as { query: { op: string } }).query.op
        if (op === 'project.catalog') { await gate; return { ok: true, result: remote } }
        if (op === 'session.list') return { ok: true, result: [] }
        if (op === 'models.list') return { ok: true, result: catalogFixture }
        if (op === 'host.version') return { ok: true, result: versionFixture }
        if (op === 'host.permissions') return { ok: true, result: { deviceId: 'device',
          projectScope: { kind: 'all' }, allowTerminal: false, managedLeaseExpiresAt: null } }
      }
      return base(method, params)
    })
    render(<App />)
    await finishFirstRun()
    await waitFor(() => expect(localArrived).toBe(true))
    expect(screen.queryByRole('button', { name: 'Execution machine' })).toBeNull()
    expect(readProjectDrafts()).toHaveLength(0)
    await act(async () => release())
    fireEvent.click(await screen.findByRole('button', { name: 'Execution machine' }))
    expect(screen.getByRole('option', { name: /Studio computer/ })).toBeEnabled()
    expect(readProjectDrafts()[0]?.group.checkouts.map((entry) => entry.hostId)).toEqual(['local', host.id])
    expect(invoke.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
  })

  it('drops a delayed setup handoff after space navigation without a pointer or key event', async () => {
    const base = invoke.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    let waiting = false
    invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.localSnapshot' && projects.length > 0) {
        waiting = true
        await gate
      }
      return base(method, params)
    })
    render(<App />)
    await finishFirstRun()
    await waitFor(() => expect(waiting).toBe(true))
    act(() => spaceActions.create())
    const newerSpace = spaceStoreSnapshot().activeSpaceId
    await act(async () => release())
    await waitFor(() => expect(invoke.mock.calls.some(([method]) => method === 'project.list')).toBe(true))
    expect(spaceStoreSnapshot().activeSpaceId).toBe(newerSpace)
    expect(readProjectDrafts()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Execution machine' })).toBeNull()
    expect(invoke.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
  })
  it('opens Aria on startup when there is no session to restore', async () => {
    settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
    projects = [project]
    render(<App />)
    expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('aria.open', {
      driverKind: 'claude',
      modelId: null,
      effort: null,
      permissionMode: 'full',
    })
    expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('opens a fresh Aria chat only after its sidebar confirmation', async () => {
    settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
    projects = [project]
    render(<App />)
    await screen.findByText('Opened session sess_aria')
    fireEvent.click(screen.getByRole('button', { name: 'Aria actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }))
    expect(invoke.mock.calls.some(([method]) => method === 'aria.newChat')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new Aria chat' }))
    expect(await screen.findByText('Opened session sess_fresh_aria')).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('aria.newChat')
    expect(sessions.filter((session) => session.projectId === 'helm')).toHaveLength(1)
    expect(screen.queryByText('Opened session sess_aria')).not.toBeInTheDocument()
  })

  it('keeps a restored session and opens Aria with its pinned row and Mod+0', async () => {
    settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
    projects = [project]
    sessions = [
      {
        id: 'sess_restored',
        projectId: project.id,
        title: 'Restored session',
        messageCount: 1,
        updatedAt: 1,
      },
    ]
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sess_restored')
    render(<App />)
    expect(await screen.findByText('Opened session sess_restored')).toBeVisible()
    expect(invoke.mock.calls.some(([method]) => method === 'aria.open')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open Aria' }))
    expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^Restored session/ }))
    expect(await screen.findByText('Opened session sess_restored')).toBeVisible()
    fireEvent.keyDown(window, { key: '0', ctrlKey: true })
    expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('selects the known Aria chat by pointer and shortcut without waiting for discovery', async () => {
    const user = userEvent.setup()
    settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
    projects = [project]
    sessions = [
      {
        id: 'sess_restored',
        projectId: project.id,
        title: 'Restored session',
        messageCount: 1,
        updatedAt: 1,
      },
      { id: 'sess_old_aria', projectId: 'helm', title: 'Old Aria', messageCount: 1, updatedAt: 1 },
      { id: 'sess_aria', projectId: 'helm', title: 'Aria', messageCount: 1, updatedAt: 2 },
      {
        id: 'sess_archived_aria',
        projectId: 'helm',
        title: 'Archived Aria',
        messageCount: 1,
        updatedAt: 3,
        archived: true,
      },
    ]
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sess_restored')
    const original = invoke.getMockImplementation()!
    let finishList!: () => void
    const initialList = new Promise<void>((resolve) => {
      finishList = resolve
    })
    invoke.mockImplementation(async (method, params) => {
      if (method === 'session.list') await initialList
      return original(method, params)
    })
    render(<App />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('session.list'))
    await act(async () => finishList())
    await screen.findByText('Opened session sess_restored')
    // Establish loaded sidebar state before holding subsequent discovery calls.
    // DOM observations await React's commit, while the unresolved RPCs still
    // prevent a discovery-based navigation path from satisfying this regression.
    await screen.findByRole('button', { name: /^Restored session/ })
    invoke.mockImplementation((method, params) =>
      method === 'aria.open' || method === 'session.list'
        ? new Promise(() => {})
        : original(method, params),
    )
    const calls = invoke.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Open Aria' }))
    expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await user.click(screen.getByRole('button', { name: /^Restored session/ }))
    expect(await screen.findByText('Opened session sess_restored')).toBeVisible()
    await user.keyboard('{Control>}0{/Control}')
    expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
    expect(
      invoke.mock.calls
        .slice(calls)
        .some(([method]) => method === 'aria.open' || method === 'session.list'),
    ).toBe(false)
  })

  it('does not let a late Aria open replace a newer session selection', async () => {
    const user = userEvent.setup()
    settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
    projects = [project]
    sessions = [
      {
        id: 'sess_restored',
        projectId: project.id,
        title: 'Restored session',
        messageCount: 1,
        updatedAt: 1,
      },
      {
        id: 'sess_other',
        projectId: project.id,
        title: 'Other session',
        messageCount: 1,
        updatedAt: 2,
      },
    ]
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sess_restored')
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (method, params) => {
      if (method === 'aria.open') await pending
      return original(method, params)
    })
    render(<App />)
    await screen.findByText('Opened session sess_restored')
    await user.click(screen.getByRole('button', { name: 'Open Aria' }))
    await user.click(screen.getByRole('button', { name: /^Other session/ }))
    expect(screen.getByText('Opened session sess_other')).toBeVisible()
    finish()
    await waitFor(() => expect(sessions.some((session) => session.id === 'sess_aria')).toBe(true))
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([method]) => method === 'session.list').length,
      ).toBeGreaterThanOrEqual(2),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open Aria' })).not.toHaveAttribute(
        'aria-current',
        'page',
      ),
    )
    expect(screen.getByText('Opened session sess_other')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open Aria' })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
    await user.click(screen.getByRole('button', { name: 'Open Aria' }))
    expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
  })

  it.each(['aria.open', 'session.list'])(
    'can retry a failed %s without losing the selected chat',
    async (failure) => {
      const user = userEvent.setup()
      settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: 1 } })
      projects = [project]
      sessions = [
        {
          id: 'sess_restored',
          projectId: project.id,
          title: 'Restored session',
          messageCount: 1,
          updatedAt: 1,
        },
      ]
      splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sess_restored')
      const original = invoke.getMockImplementation()!
      let openRequested = false
      let rejected = false
      let rejectDiscovery!: (error: Error) => void
      const pendingFailure = new Promise<never>((_, reject) => {
        rejectDiscovery = reject
      })
      invoke.mockImplementation(async (method, params) => {
        if (method === 'aria.open') openRequested = true
        if (openRequested && method === failure && !rejected) {
          rejected = true
          return pendingFailure
        }
        return original(method, params)
      })
      render(<App />)
      await screen.findByText('Opened session sess_restored')
      await user.click(screen.getByRole('button', { name: 'Open Aria' }))
      // Fail this click's discovery after userEvent finishes. Initial list
      // refreshes cannot consume the failure, and slow pointer processing
      // cannot let the transient toast expire before the assertion.
      await waitFor(() => expect(rejected).toBe(true))
      await act(async () => rejectDiscovery(new Error('Transient discovery failure')))
      await screen.findByText('Could not open Aria')
      expect(screen.getByText('Opened session sess_restored')).toBeVisible()
      await user.click(screen.getByRole('button', { name: 'Open Aria' }))
      expect(await screen.findByText('Opened session sess_aria')).toBeVisible()
      expect(sessions.filter((session) => session.projectId === 'helm')).toHaveLength(1)
    },
  )
  it('finishes first run into an agent draft, retains it through setup, and creates only on first Send', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Meet your coding agents.' })
    await screen.findByText('Sign-in found')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Add Ari/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    await screen.findByRole('button', { name: 'Execution machine' })
    const input = screen.getByRole('textbox', { name: 'Message' })
    expect(settings.onboarding?.completedAt).toBeGreaterThan(0)
    expect(settings.sessions.defaultDriverKind).toBe('claude')
    expect(loadLastPick()?.driverKind).toBe('claude')
    expect(activeSessionOf(splitLayoutSnapshot())).toBeNull()
    expect(
      invoke.mock.calls.some(
        ([method]) => ['session.create', 'command.dispatch', 'aria.open'].includes(method),
      ),
    ).toBe(false)
    await user.type(input, 'Keep this first prompt through setup')
    const draft = readProjectDrafts()[0]
    expect(draft?.group.checkouts).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostId: 'local', projectId: project.id })]),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run setup again' }))
    await screen.findByRole('heading', { name: 'Meet your coding agents.' })
    expect(input).not.toBeVisible()
    const count = invoke.mock.calls.length
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke.mock.calls.slice(count).some(([method]) => method === 'session.create')).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
    expect(await screen.findByRole('button', { name: 'Run setup again' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('button', { name: 'Execution machine' })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'Keep this first prompt through setup',
    )
    expect(readProjectDrafts()).toEqual([draft])
    expect(invoke.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(0)
    await waitFor(() =>
      expect(
        screen.queryByText('This agent is unavailable on the selected machine.'),
      ).not.toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const opened = await screen.findByText('Opened session sess_onboarded')
    expect(opened).toBeVisible()
    expect(opened).toHaveAttribute('data-scope', 'local')
    expect(activeSessionOf(splitLayoutSnapshot())).toBe('sess_onboarded')
    expect(invoke.mock.calls.filter(([method]) => method === 'session.create')).toEqual([
      ['session.create', expect.objectContaining({ projectId: project.id, driverKind: 'claude' })],
    ])
    expect(invoke.mock.calls.filter(([method]) => method === 'command.dispatch')).toEqual([
      [
        'command.dispatch',
        {
          command: {
            type: 'turn.start',
            sessionId: 'sess_onboarded',
            text: 'Keep this first prompt through setup',
            attachments: [],
          },
        },
      ],
    ])
    expect(readProjectDrafts()).toHaveLength(0)
  })

  it('resumes an interrupted setup without duplicating its already-created first session', async () => {
    settings = settingsSchema.parse({ version: 1, onboarding: { completedAt: null } })
    projects = [project]
    sessions = [
      {
        id: 'sess_existing_first',
        projectId: project.id,
        title: 'First session',
        messageCount: 0,
        updatedAt: 1,
      },
    ]
    render(<App />)
    await screen.findByRole('heading', { name: 'Meet your coding agents.' })
    await screen.findByText('Sign-in found')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Add Ari/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('checkbox', { name: 'Open a new chat in Ari' })).not.toBeChecked()
    expect(settings.onboarding?.completedAt).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    await waitFor(() => expect(settings.onboarding?.completedAt).toBeGreaterThan(0))
    expect(invoke.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
    expect(sessions[0]?.id).toBe('sess_existing_first')
  })

  it('remembers a skip across remounts without requiring an agent or project', async () => {
    const first = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Skip setup' }))
    await screen.findByText('Opened session sess_aria')
    first.unmount()
    render(<App />)
    await waitFor(() => expect(screen.getByText('Opened session sess_aria')).toBeVisible())
    expect(screen.queryByRole('main', { name: 'Ari setup' })).not.toBeInTheDocument()
    expect(projects).toHaveLength(0)
    expect(sessions).toHaveLength(1)
    expect(invoke.mock.calls.filter(([method]) => method === 'aria.open')).toHaveLength(1)
  })

  it('bypasses the wizard for an existing workspace and records its migration', async () => {
    projects = [project]
    render(<App />)
    await screen.findByText('Opened session sess_aria')
    expect(screen.queryByRole('main', { name: 'Ari setup' })).not.toBeInTheDocument()
    await waitFor(() => expect(settings.onboarding?.completedAt).toBeGreaterThan(0))
    expect(invoke.mock.calls.some(([method]) => method === 'project.discover')).toBe(false)
  })
})

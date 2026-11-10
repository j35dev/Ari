import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { useRef, useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import { commandSchema } from '@ari/contracts/commands'
import type { Project } from '@ari/contracts/project'
import { sessionCreateParamsSchema } from '@ari/contracts/rpc'
import { settingsSchema } from '@ari/contracts/settings'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import type { AdapterSession } from '@ari/providers/driver'
import { Engine } from '../../../main/engine'
import { startAgentRuntime } from '../../../main/agent-runtime'
import { createSession } from '../../../main/session-create'
import { SessionView, type SessionDefaults } from '../features/session/SessionView'
import { dropDraftIntentMemory } from '../features/composer/draft-recovery-store'
import { dropDraftTextMemory } from '../features/composer/use-drafts'
import { NewSessionLauncher } from './NewSessionLauncher'
import { captureSessionStartIntent, type SessionStartIntent } from './session-start-focus'
import { useSessionStart } from './use-session-start'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../lib/rpc', () => ({ rpc: rpcMocks }))
const execute = promisify(execFile)
const cliPath = resolve('resources/cli/ari.cjs')
afterEach(cleanup)

// The real launcher, start controller, composer, journal, engine and local control
// transport. Only the renderer IPC bridge and model response are deterministic.
it.each(['pointer', 'search Enter', 'Lead button'] as const)(
  'creates a fresh session via %s and runs its first composer turn',
  async (gesture) => {
    dropDraftIntentMemory()
    dropDraftTextMemory()
    localStorage.clear()
    const dir = await mkdtemp(join(tmpdir(), 'ari-session-start-runtime-'))
    const store = new SessionStore({ rootDir: join(dir, 'sessions') })
    const project: Project = {
      id: 'project',
      name: 'Demo',
      path: dir,
      colorIndex: 0,
      createdAt: 1,
      lastOpenedAt: 1,
      open: true,
      status: 'ok',
    }
    const defaults: SessionDefaults = {
      driverKind: 'claude',
      modelId: 'opus',
      permissionMode: 'full',
      effort: 'xhigh',
    }
    const registry = new DriverRegistry()
    const seen: AdapterSession[] = []
    registry.register({
      kind: 'claude',
      systemInstructions: true,
      create: async (session) => {
        seen.push(session)
        return {
          start: () => ({
            async *[Symbol.asyncIterator]() {
              // Cross a real child-process + authenticated named-pipe/socket
              // boundary with the first turn's scoped runtime environment.
              const { stdout } = await execute(process.execPath, [cliPath, 'env', '--json'], {
                cwd: session.workspacePath,
                env: session.runtimeEnv,
                windowsHide: true,
                timeout: 10_000,
              })
              const identity = JSON.parse(stdout) as {
                ok: boolean
                result: { caller: { sessionId: string } }
              }
              if (!identity.ok || identity.result.caller.sessionId !== session.sessionId)
                throw new Error('First-turn runtime identity did not match the created session')
              yield { type: 'session-ref' as const, ref: `fresh-${session.sessionId}` }
              yield { type: 'text-delta' as const, text: 'First turn started successfully.' }
              yield { type: 'done' as const }
            },
          }),
          interrupt: () => undefined,
          dispose: async () => undefined,
        }
      },
    })
    const engine = new Engine({
      store,
      registry,
      publish: () => undefined,
      resolveWorkspace: async () => dir,
      runtimeEnvironment: async (session) => runtime.environment(session),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    })
    const runtime = await startAgentRuntime({
      engine,
      store,
      userData: dir,
      cliPath,
      executable: process.execPath,
      version: 'test',
      policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
      providers: async () => [{ driverKind: 'claude', available: true, models: [] }],
      baseEnv: {},
      socketRoot: tmpdir(),
    })
    rpcMocks.invoke.mockReset()
    rpcMocks.invoke.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      switch (method) {
        case 'session.create':
          return createSession(
            {
              loadProject: async (id) => {
                if (id !== project.id) throw new Error('Unknown project')
                return project
              },
              createSession: (session) => engine.createSession(session),
            },
            sessionCreateParamsSchema.parse(params),
          )
        case 'command.dispatch':
          return engine.dispatch(commandSchema.parse(params.command))
        case 'session.load':
          return store.load(params.sessionId as string)
        case 'session.list':
          return store.listSessions()
        case 'session.workspace':
          return { path: dir }
        case 'project.list':
          return [project]
        case 'settings.get':
          return settingsSchema.parse({ version: 1 })
        case 'files.index':
          return { paths: [] }
        case 'git.turnDiff':
          return { diffText: '' }
        case 'providers.detect':
        case 'providers.models':
        case 'endpoints.list':
        case 'session.tasks':
          return []
        default:
          return undefined
      }
    })
    rpcMocks.subscribe.mockReset()
    rpcMocks.subscribe.mockImplementation(
      (name: string, params: { sessionId?: string }, callback: (payload: unknown) => void) => {
        if (name !== 'session.events' || !params.sessionId) return () => undefined
        const sessionId = params.sessionId
        let active = true
        const stop = store.subscribe((event) => {
          if (active && event.sessionId === sessionId) act(() => callback({ sessionId, event }))
        })
        void engine.replaySession(sessionId).then((events) => {
          if (!active) return
          act(() => {
            callback({ sessionId, replay: true, events })
            callback({ sessionId, replayDone: true, replayOutcome: 'complete', liveTurnId: null })
          })
        })
        return () => {
          active = false
          stop()
        }
      },
    )

    function Harness() {
      const [open, setOpen] = useState(false)
      const [selected, setSelected] = useState<string | null>(null)
      const [config, setConfig] = useState(defaults)
      const scope = useRef({ spaceId: 'space', paneId: 'pane', sessionId: null as string | null })
      const intent = useRef<SessionStartIntent | null>(null)
      const start = useSessionStart({
        defaults,
        sessions: [],
        captureIntent: () =>
          captureSessionStartIntent(
            () => scope.current,
            () => true,
            () => {},
          ),
        onStarted: (sessionId, effective, ownership) => {
          if (!ownership.select(sessionId)) return
          scope.current = { ...scope.current, sessionId }
          intent.current = ownership
          if (effective) setConfig(effective)
          setSelected(sessionId)
        },
        refreshProjects: () => {},
        refreshSessions: () => {},
        checkSessions: async () => {},
      })
      return (
        <>
          <button onClick={() => setOpen(true)}>New session</button>
          <NewSessionLauncher
            open={open}
            projects={[project]}
            sessions={[]}
            onClose={() => setOpen(false)}
            onAddProject={() => {}}
            onCreate={(id, lead) => start.create(id, lead ? { lead: true } : undefined)}
          />
          {selected && (
            <SessionView
              sessionId={selected}
              defaults={config}
              onDefaultsChange={setConfig}
              onComposerReady={(editor) => intent.current?.ready(editor)}
            />
          )}
        </>
      )
    }
    try {
      const user = userEvent.setup()
      render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      )
      await user.click(screen.getByRole('button', { name: 'New session' }))
      const chooser = await screen.findByRole('dialog', { name: 'New session' })
      expect(within(chooser).getByRole('textbox', { name: 'Search projects' })).toHaveFocus()
      if (gesture === 'pointer')
        await user.click(within(chooser).getByRole('option', { name: 'Demo' }))
      else if (gesture === 'search Enter') await user.keyboard('{Enter}')
      else await user.click(within(chooser).getByRole('button', { name: 'Lead session in Demo' }))

      const editor = await screen.findByRole<HTMLTextAreaElement>(
        'textbox',
        { name: 'Message' },
        { timeout: 10_000 },
      )
      await waitFor(() => expect(editor).toHaveFocus(), { timeout: 10_000 })
      const [row] = await store.listSessions()
      expect(row).toBeDefined()
      const sessionId = row!.id
      const fresh = await store.load(sessionId)
      expect(fresh.session).toMatchObject({ ...defaults, status: 'idle' })
      expect(fresh.session?.lead).toBe(gesture === 'Lead button' ? true : undefined)
      expect(fresh.providerSessionId).toBeNull()
      expect(fresh.messages).toHaveLength(0)
      expect(seen).toHaveLength(0)

      await user.type(editor, 'Hello from the new session{Enter}')
      await waitFor(
        async () => expect((await store.load(sessionId)).lastTurn?.stopReason).toBe('completed'),
        { timeout: 10_000 },
      )
      expect(await screen.findByText('First turn started successfully.')).toBeVisible()
      await engine.quiesce(sessionId)
      expect(seen).toHaveLength(1)
      const { runtimeEnv, ...firstTurn } = seen[0]!
      expect(firstTurn).toMatchObject({
        sessionId,
        workspacePath: dir,
        prompt: 'Hello from the new session',
        modelId: defaults.modelId,
        permissionMode: defaults.permissionMode,
        effort: defaults.effort,
        resumeOf: null,
      })
      const settled = await store.load(sessionId)
      expect(settled.lastTurn?.stopReason).toBe('completed')
      expect(settled.activeTurnId).toBeNull()
      expect(settled.providerSessionId).toBe(`fresh-${sessionId}`)
      const disk = new SessionStore({ rootDir: join(dir, 'sessions') })
      try {
        expect((await disk.load(sessionId)).lastTurn?.stopReason).toBe('completed')
        expect(disk.replayDiagnostics(sessionId).rejectedCount).toBe(0)
      } finally {
        await disk.closeJournal(sessionId)
      }
      const events = await engine.replaySession(sessionId)
      const secret = runtimeEnv?.ARI_CONTROL_TOKEN
      expect(typeof secret === 'string' && secret.length > 0).toBe(true)
      expect(JSON.stringify(events).includes(secret!)).toBe(false)
    } finally {
      cleanup()
      await runtime.close()
      for (const row of await store.listSessions()) {
        await engine.quiesce(row.id)
        await store.closeJournal(row.id)
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  },
)

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import { commandSchema } from '@ari/contracts/commands'
import type { Project } from '@ari/contracts/project'
import { settingsSchema } from '@ari/contracts/settings'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from '../../main/engine'
import { startAgentRuntime } from '../../main/agent-runtime'
import { AriaThread } from '../../main/aria-thread'
import { createSession } from '../../main/session-create'
import { App } from './App'
import { dropDraftIntentMemory } from './features/composer/draft-recovery-store'
import { dropDraftTextMemory } from './features/composer/use-drafts'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { keepAliveActions } from './features/session/session-keep-alive'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(), record: vi.fn() }))
vi.mock('./lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: mocks.subscribe } }))
// Only physical microphone capture and renderer IPC are replaced. Navigation,
// composer, history, disk store, engine and scoped runtime transport are real.
vi.mock('./features/speech/recorder', () => ({ startRecording: mocks.record }))
vi.mock('./features/focus', () => ({ FocusPill: () => null }))
vi.mock('./features/usage/ProviderUsagePill', () => ({ ProviderUsagePill: () => null }))
const execute = promisify(execFile)
const cliPath = resolve('resources/cli/ari.cjs')

it.each(['idle', 'responding'] as const)(
  'switches a %s project chat to Aria without discovery, losing drafts or stopping its turn',
  async (state) => {
    localStorage.clear()
    dropDraftIntentMemory()
    dropDraftTextMemory()
    splitLayoutActions.reset()
    keepAliveActions.reset()
    const dir = await mkdtemp(join(tmpdir(), 'ari-aria-navigation-'))
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
    const pick = {
      driverKind: 'claude' as const,
      modelId: 'opus',
      permissionMode: 'full' as const,
      effort: 'xhigh',
    }
    const settings = settingsSchema.parse({
      experimental: { ariaEnabled: true },
      version: 1,
      onboarding: { completedAt: 1 },
      sessions: { defaultDriverKind: 'claude', defaultPermissionMode: 'full' },
      appearance: { reducedMotion: true },
    })
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = new DriverRegistry()
    const callers: string[] = []
    registry.register({
      kind: 'claude',
      systemInstructions: true,
      create: async (session) => ({
        start: () => ({
          async *[Symbol.asyncIterator]() {
            const { stdout } = await execute(process.execPath, [cliPath, 'env', '--json'], {
              cwd: dir,
              env: session.runtimeEnv,
              windowsHide: true,
              timeout: 10_000,
            })
            const identity = JSON.parse(stdout) as {
              ok: boolean
              result: { caller: { sessionId: string } }
            }
            if (!identity.ok || identity.result.caller.sessionId !== session.sessionId)
              throw new Error('Runtime caller does not match the selected chat')
            callers.push(session.sessionId)
            yield { type: 'text-delta' as const, text: 'Runtime response in the intended chat.' }
            if (session.prompt === 'Keep working') await pending
            yield { type: 'done' as const }
          },
        }),
        interrupt: () => release(),
        dispose: async () => undefined,
      }),
    })
    const engine = new Engine({
      store,
      registry,
      publish: () => {},
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
    const deps = {
      loadProject: async () => project,
      createSession: (session: Parameters<Engine['createSession']>[0]) =>
        engine.createSession(session),
    }
    const aria = new AriaThread({
      ...deps,
      listSessions: () => store.listSessions(),
      loadSession: async (id) => (await store.load(id)).session,
      destroySession: async () => {
        throw new Error('Navigation must not delete a chat')
      },
      settings: async () => settings,
      defaults: async () => pick,
    })
    const projectChat = await createSession(deps, {
      ...pick,
      projectId: project.id,
      title: 'Project chat',
    })
    const ariaChat = await aria.open()
    let discoveryBlocked = false
    let metadataFailed = false
    let historyFailed = false
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        switch (method) {
          case 'session.list':
            if (discoveryBlocked) return new Promise(() => {})
            return store.listSessions()
          case 'aria.open':
            return aria.open()
          case 'session.load':
            if (state === 'idle' && params.sessionId === ariaChat.sessionId && !metadataFailed) {
              metadataFailed = true
              throw new Error('Transient metadata read failure')
            }
            return store.load(params.sessionId as string)
          case 'command.dispatch':
            return engine.dispatch(commandSchema.parse(params.command))
          case 'session.workspace':
            return { path: dir }
          case 'project.list':
            return [project]
          case 'settings.get':
            return settings
          case 'app.info':
            return { platform: 'win32', version: 'test', homeDir: dir }
          case 'ping':
            return { pong: true }
          case 'providers.detect':
            return [
              {
                kind: 'claude',
                binaryPath: 'fixture',
                installed: true,
                authStatus: 'authenticated',
              },
            ]
          case 'providers.models':
          case 'endpoints.list':
          case 'session.tasks':
            return []
          case 'files.index':
            return { paths: [] }
          case 'git.turnDiff':
            return { diffText: '' }
          case 'speech.status':
            return { ready: true, engine: 'ready', model: null }
          default:
            return undefined
        }
      },
    )
    mocks.subscribe.mockReset()
    mocks.subscribe.mockImplementation(
      (name: string, params: { sessionId?: string }, callback: (payload: unknown) => void) => {
        if (name !== 'session.events') return () => {}
        const id = params.sessionId
        let active = true
        const stop = store.subscribe((event) => {
          if (active && (!id || id === event.sessionId))
            act(() => callback({ sessionId: event.sessionId, event }))
        })
        if (id)
          void engine.replaySession(id).then((events) => {
            if (!active) return
            const incomplete = state === 'idle' && id === ariaChat.sessionId && !historyFailed
            if (incomplete) historyFailed = true
            act(() => {
              callback({ sessionId: id, replay: true, events })
              callback({
                sessionId: id,
                replayDone: true,
                replayOutcome: incomplete ? 'incomplete' : 'complete',
                liveTurnId: engine.hasLiveTurn(id)
                  ? ((
                      events.findLast((e) => e.type === 'turn.started') as
                        { turnId?: string } | undefined
                    )?.turnId ?? null)
                  : null,
              })
            })
          })
        return () => {
          active = false
          stop()
        }
      },
    )
    const cancel = vi.fn()
    mocks.record.mockResolvedValue({ cancel, stop: async () => new Float32Array(), level: () => 0 })
    try {
      if (state === 'responding') {
        await engine.dispatch({
          type: 'turn.start',
          sessionId: projectChat.sessionId,
          text: 'Keep working',
          attachments: [],
        })
        await waitFor(() => expect(callers).toContain(projectChat.sessionId))
      }
      splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, projectChat.sessionId)
      const user = userEvent.setup()
      render(<App />)
      const input = await screen.findByRole('textbox', { name: 'Message' })
      await waitFor(() => expect(input).not.toBeDisabled())
      await user.type(input, 'Unsent project draft')
      if (state === 'idle') {
        await user.click(await screen.findByRole('button', { name: 'Dictate a message' }))
        await screen.findByRole('button', { name: 'Stop dictation' })
      }
      discoveryBlocked = true
      const calls = mocks.invoke.mock.calls.length
      await user.click(screen.getByRole('button', { name: 'Open Aria' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveAttribute(
          'aria-current',
          'page',
        ),
      )
      expect(mocks.invoke.mock.calls.slice(calls).some(([method]) => method === 'aria.open')).toBe(
        false,
      )
      if (state === 'idle') {
        await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
        await user.click(await screen.findByRole('button', { name: 'Retry session details' }))
        await user.click(await screen.findByRole('button', { name: 'Retry history' }))
        await waitFor(() =>
          expect(screen.queryByText('Session details could not be loaded.')).toBeNull(),
        )
        await waitFor(() =>
          expect(
            screen.queryByText('History is incomplete. Some saved messages could not be loaded.'),
          ).toBeNull(),
        )
      } else expect(engine.hasLiveTurn(projectChat.sessionId)).toBe(true)
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Unsent Aria draft')
      for (let i = 0; i < 3; i++) {
        await user.click(screen.getByRole('button', { name: /^Project chat/ }))
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent project draft')
        await user.click(screen.getByRole('button', { name: 'Open Aria' }))
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent Aria draft')
      }
      discoveryBlocked = false
      release()
      await user.click(screen.getByRole('textbox', { name: 'Message' }))
      await user.keyboard('{Enter}')
      await waitFor(
        async () =>
          expect((await store.load(ariaChat.sessionId)).lastTurn?.stopReason).toBe('completed'),
        { timeout: 10_000 },
      )
      expect(callers).toContain(ariaChat.sessionId)
      if (state === 'responding')
        await waitFor(async () =>
          expect((await store.load(projectChat.sessionId)).lastTurn?.stopReason).toBe('completed'),
        )
      expect(
        (await store.load(projectChat.sessionId)).messages
          .filter((message) => message.role === 'user')
          .map((message) => message.parts),
      ).not.toContainEqual([{ type: 'text', text: 'Unsent project draft' }])
    } finally {
      release()
      discoveryBlocked = false
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

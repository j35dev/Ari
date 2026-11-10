// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import { navigateFrameSchema } from '@ari/contracts/rpc'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'
import { startAgentRuntime } from './agent-runtime'
import { AppNavigation } from './app-navigation'
import { RpcRegistry } from './rpc-registry'

const execute = promisify(execFile)
it('threads the shipped CLI through authenticated runtime/Engine and targeted RPC acknowledgement without disturbing a running turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-nav-runtime-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const drivers = new DriverRegistry()
  let finishTurn!: () => void
  const turnGate = new Promise<void>((done) => {
    finishTurn = done
  })
  const interrupt = vi.fn()
  drivers.register({
    kind: 'claude',
    create: async () => ({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          await turnGate
          yield { type: 'done' as const }
        },
      }),
      interrupt,
      dispose: async () => undefined,
    }),
  })
  const engine = new Engine({
    store,
    registry: drivers,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const session = (id: string, projectId: string): Session => ({
    id,
    projectId,
    title: id,
    driverKind: 'claude',
    modelId: 'fixture',
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  })
  const aria = session('aria', 'helm')
  const worker = session('worker', 'p')
  await engine.createSession(aria)
  await engine.createSession(worker)
  let publications = 0
  const rpc = new RpcRegistry({
    send: ({ payload }) => {
      const parsed = navigateFrameSchema.parse(payload)
      if (!('kind' in parsed) || parsed.kind !== 'app.open') return
      publications += 1
      // This is a scripted consumer of the real RPC boundary, not native UI evidence.
      void rpc
        .invoke('app.navigation.validate', {
          consumerId: 'scripted-shell',
          requestId: parsed.requestId,
        })
        .then(() =>
          rpc.invoke('app.navigation.ack', {
            consumerId: 'scripted-shell',
            receipt: {
              requestId: parsed.requestId,
              target: parsed.target,
              status: 'applied',
              observed: {
                target: parsed.target,
                mode:
                  parsed.target.view === 'settings'
                    ? 'settings'
                    : parsed.target.view === 'changes'
                      ? 'sidebar'
                      : 'chat',
              },
            },
          }),
        )
    },
  })
  const validate: AppNavigation['deps']['validate'] = (caller, target) =>
    runtime.service.validateAppOpen(caller, target)
  const navigation = new AppNavigation({
    registry: rpc,
    validate: (caller, target) => validate(caller, target),
  })
  rpc.register('app.navigation.validate', ({ consumerId, requestId }) =>
    navigation.validate(consumerId, requestId),
  )
  rpc.register('app.navigation.ack', ({ consumerId, receipt }) =>
    navigation.acknowledge(consumerId, receipt),
  )
  rpc.subscribe({
    id: 'scripted',
    name: 'app.navigate',
    params: { navigationConsumerId: 'scripted-shell' },
  })
  navigation.consumer('scripted-shell', true)
  const providers = vi.fn(async () => [])
  const runtime = await startAgentRuntime({
    engine,
    store,
    userData: dir,
    cliPath: resolve('resources/cli/ari.cjs'),
    executable: process.execPath,
    version: 'test',
    policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
    providers,
    projects: async () => [{ projectId: 'p', name: 'P', path: dir, available: true }],
    openApp: (caller, target, requestId, signal) =>
      navigation.open(caller, target, requestId, signal),
  })
  const cli = async (caller: Session, ...args: string[]) => {
    try {
      const { stdout } = await execute(
        process.execPath,
        [resolve('resources/cli/ari.cjs'), ...args, '--json'],
        { env: runtime.environment(caller), windowsHide: true, timeout: 20_000 },
      )
      return JSON.parse(stdout) as { ok: boolean; result?: unknown; error?: { code: string } }
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout
      if (!stdout) throw error
      return JSON.parse(stdout) as { ok: boolean; error: { code: string } }
    }
  }
  const started = new Promise<void>((done) => {
    const unsubscribe = store.subscribe((event) => {
      if (event.sessionId === worker.id && event.type === 'turn.started') {
        unsubscribe()
        done()
      }
    })
  })
  const settled = new Promise<void>((done) => {
    const unsubscribe = store.subscribe((event) => {
      if (event.sessionId === worker.id && event.type === 'turn.settled') {
        unsubscribe()
        done()
      }
    })
  })
  try {
    await engine.dispatch({
      type: 'turn.start',
      sessionId: worker.id,
      text: 'Keep running',
      attachments: [],
    })
    await started
    const activeTurnId = (await store.load(worker.id)).activeTurnId
    for (const args of [
      ['session', 'worker'],
      ['aria'],
      ['settings'],
      ['changes', '--session', 'worker'],
    ]) {
      const first = await cli(aria, 'app', 'open', ...args, '--key', args[0]!)
      expect(first).toMatchObject({ ok: true, result: { status: 'applied' } })
      expect(await cli(aria, 'app', 'open', ...args, '--key', args[0]!)).toEqual(first)
    }
    expect(publications).toBe(4)
    expect(await cli(worker, 'app', 'open', 'settings', '--key', 'worker-refused')).toMatchObject({
      ok: false,
      error: { code: 'scope_denied' },
    })
    expect((await store.load(worker.id)).activeTurnId).toBe(activeTurnId)
    expect(
      (await store.load(worker.id)).messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1)
    expect(interrupt).not.toHaveBeenCalled()
    expect(providers).not.toHaveBeenCalled()
  } finally {
    finishTurn()
    await settled
    navigation.reset()
    await runtime.close()
    await store.closeJournal(aria.id)
    await store.closeJournal(worker.id)
    await rm(dir, { recursive: true, force: true })
  }
})

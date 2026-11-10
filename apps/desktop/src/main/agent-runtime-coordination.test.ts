// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { Driver } from '@ari/providers/driver'
import { DriverRegistry } from '@ari/providers/registry'
import { UNKNOWN_PROVIDER_CAPABILITIES } from '@ari/providers/driver'
import { SessionStore } from '@ari/engine/session-store'
import { Engine } from './engine'
import { startAgentRuntime } from './agent-runtime'

const execute = promisify(execFile)

async function withRuntime(
  driver: Driver,
  run: (
    engine: Engine,
    runtime: Awaited<ReturnType<typeof startAgentRuntime>>,
    store: SessionStore,
  ) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ari-coordination-startup-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  registry.register(driver)
  let runtime: Awaited<ReturnType<typeof startAgentRuntime>> | undefined
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async (session) => runtime?.environment(session) ?? {},
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  try {
    for (const id of ['aria', 'sender'])
      await engine.createSession({
        id,
        projectId: id === 'aria' ? 'helm' : 'project',
        title: id,
        driverKind: 'codex',
        modelId: 'model',
        permissionMode: 'full',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        ...(id === 'sender' ? { createdBy: { kind: 'session', sessionId: 'aria' } } : {}),
      })
    runtime = await startAgentRuntime({
      userData: dir,
      cliPath: resolve('resources/cli/ari.cjs'),
      executable: process.execPath,
      version: 'test',
      engine,
      store,
      policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
      providers: async () => [],
    })
    await run(engine, runtime, store)
  } finally {
    await runtime?.close()
    await engine.shutdown()
    for (const id of ['aria', 'sender']) await store.closeJournal(id)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

it('reconciles a note accepted after the prompt snapshot while the live adapter is still starting', async () => {
  let entered!: () => void
  let releaseCreate!: () => void
  let releaseTurn!: () => void
  const creating = new Promise<void>((resolve) => {
    entered = resolve
  })
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const steering: string[] = []
  await withRuntime(
    {
      kind: 'codex',
      create: async () => {
        entered()
        await createGate
        async function* events(): AsyncGenerator<AgentEvent> {
          await turnGate
          yield { type: 'done' }
        }
        return {
          capabilities: () => ({ ...UNKNOWN_PROVIDER_CAPABILITIES, steering: 'live' }),
          steer: async (text) => {
            steering.push(text)
            return true
          },
          start: () => events(),
          interrupt: releaseTurn,
          dispose: async () => undefined,
        }
      },
    },
    async (engine, runtime, store) => {
      try {
        await engine.dispatch({
          type: 'turn.start',
          sessionId: 'aria',
          text: 'Coordinate work',
          attachments: [],
        })
        await creating
        const accepted = await runtime.service.invoke('sender', 'session.message', {
          targetSessionId: 'parent',
          text: 'A note accepted during startup',
          idempotencyKey: 'startup-note',
        })
        expect(accepted).toMatchObject({ ok: true, result: { status: 'pending' } })
        releaseCreate()
        await expect
          .poll(async () => Object.values((await store.load('aria')).inbox ?? {})[0]?.status, {
            timeout: 5_000,
          })
          .toBe('delivered')
        await runtime.service.deliverPendingCoordination('aria')
        expect(
          await runtime.service.invoke('sender', 'session.message', {
            targetSessionId: 'parent',
            text: 'A note accepted during startup',
            idempotencyKey: 'startup-note',
          }),
        ).toMatchObject({ ok: true, result: { status: 'delivered' } })
        expect(steering).toHaveLength(1)
        expect(steering[0]).toContain('A note accepted during startup')
        expect(Object.values((await store.load('aria')).inbox ?? {})[0]?.consumedAt).toBeNull()
      } finally {
        releaseCreate()
        releaseTurn()
      }
    },
  )
})

it('keeps a prompt inbox receipt uncertain when adapter creation fails rather than reporting delivery', async () => {
  await withRuntime(
    {
      kind: 'codex',
      create: async () => {
        throw new Error('provider submission failed')
      },
    },
    async (engine, runtime, store) => {
      await runtime.service.invoke('sender', 'session.message', {
        targetSessionId: 'parent',
        text: 'Read before responding',
        idempotencyKey: 'failed-startup-note',
      })
      await engine.dispatch({
        type: 'turn.start',
        sessionId: 'aria',
        text: 'Coordinate work',
        attachments: [],
      })
      await engine.quiesce('aria')
      expect((await store.load('aria')).lastTurn?.stopReason).toBe('error')
      expect(Object.values((await store.load('aria')).inbox ?? {})[0]).toMatchObject({
        status: 'uncertain',
        consumedAt: null,
      })
    },
  )
})

it('delivers worker questions through a lead to idle Aria, routes CLI answers and carries buffered inbox into the next real provider turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-runtime-coordination-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  const prompts: { id: string; text: string }[] = []
  let releaseLead!: () => void
  let releaseWorker!: () => void
  const leadGate = new Promise<void>((resolve) => {
    releaseLead = resolve
  })
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve
  })
  const counts = new Map<string, number>()
  registry.register({
    kind: 'codex',
    create: async (options) => {
      const count = (counts.get(options.sessionId) ?? 0) + 1
      counts.set(options.sessionId, count)
      prompts.push({ id: options.sessionId, text: options.prompt })
      async function* events(): AsyncGenerator<AgentEvent> {
        if (options.sessionId === 'lead' && count === 1) await leadGate
        if (options.sessionId === 'worker' && count === 1) {
          yield {
            type: 'input-requested',
            inputId: 'store-choice',
            prompt: 'Which storage should I use?',
            choicesJson: '["Settings","JSON"]',
          }
          await workerGate
        }
        yield {
          type: 'text-delta',
          text: `${options.sessionId} finished; verified storage choice.`,
        }
        yield { type: 'done' }
      }
      return {
        capabilities: () => ({
          ...UNKNOWN_PROVIDER_CAPABILITIES,
          liveResponses: 'approvals-and-input',
          steering: false,
        }),
        start: () => events(),
        respondInput: () => releaseWorker(),
        interrupt: () => {
          releaseLead()
          releaseWorker()
        },
        dispose: async () => undefined,
      }
    },
  })
  let runtime: Awaited<ReturnType<typeof startAgentRuntime>> | undefined
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => dir,
    runtimeEnvironment: async (session) => runtime?.environment(session) ?? {},
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  const row = (id: string): Session => ({
    id,
    projectId: id === 'aria' ? 'helm' : 'project',
    title: id,
    driverKind: 'codex',
    modelId: 'model',
    permissionMode: 'full',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...(id === 'lead'
      ? { lead: true, createdBy: { kind: 'session', sessionId: 'aria' } }
      : id === 'worker'
        ? {
            parentSessionId: 'lead',
            rootSessionId: 'lead',
            createdBy: { kind: 'session', sessionId: 'lead' },
          }
        : {}),
  })
  try {
    for (const id of ['aria', 'lead', 'worker']) await engine.createSession(row(id))
    runtime = await startAgentRuntime({
      userData: dir,
      cliPath: resolve('resources/cli/ari.cjs'),
      executable: process.execPath,
      version: 'test',
      engine,
      store,
      policy: () => delegationSettingsSchema.parse({ approvalMode: 'never' }),
      providers: async () => [],
      deliveryDelayMs: 10,
    })
    const cli = async (id: string, args: string[]) => {
      const { stdout } = await execute(
        process.execPath,
        [resolve('resources/cli/ari.cjs'), ...args, '--json'],
        { env: runtime!.environment(row(id)) },
      ).catch((error: unknown) => {
        const failure = error as { stdout?: string }
        if (!failure.stdout) throw error
        return { stdout: failure.stdout }
      })
      return JSON.parse(stdout) as {
        ok: boolean
        result: Record<string, unknown>
        error?: { code: string }
      }
    }
    await engine.dispatch({
      type: 'turn.start',
      sessionId: 'aria',
      text: 'Coordinate storage work',
      attachments: [],
    })
    await engine.quiesce('aria')
    await engine.dispatch(
      {
        type: 'turn.start',
        sessionId: 'lead',
        text: 'Implement storage using a worker',
        attachments: [],
      },
      { kind: 'session', sessionId: 'aria' },
    )
    await engine.dispatch(
      { type: 'turn.start', sessionId: 'worker', text: 'Implement storage', attachments: [] },
      { kind: 'session', sessionId: 'lead' },
    )
    await expect
      .poll(async () => (await store.load('worker')).pendingInputs.length, { timeout: 5_000 })
      .toBe(1)
    await expect
      .poll(
        async () =>
          prompts.some(
            (prompt) => prompt.id === 'aria' && prompt.text.includes('question owned by lead'),
          ),
        { timeout: 5_000 },
      )
      .toBe(true)
    const read = await cli('aria', ['session', 'read', 'worker', '--turns', '1'])
    expect(read).toMatchObject({
      ok: true,
      result: {
        questionOwnerSessionId: 'lead',
        pendingInputs: [{ inputId: 'store-choice' }],
        lastSeq: expect.any(Number),
      },
    })
    const refused = await cli('aria', [
      'session',
      'answer',
      'worker',
      '--input',
      'store-choice',
      'Settings',
      '--key',
      'wrong-answer',
    ])
    expect(refused).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
    releaseLead()
    await expect
      .poll(
        async () =>
          prompts.some(
            (prompt) =>
              prompt.id === 'lead' &&
              prompt.text.includes('ari session answer worker --input store-choice'),
          ),
        { timeout: 5_000 },
      )
      .toBe(true)
    const note = await cli('aria', [
      'session',
      'message',
      'worker',
      'Also verify persistence',
      '--key',
      'persistence-note',
    ])
    expect(note).toMatchObject({ ok: true, result: { status: 'pending' } })
    await cli('aria', [
      'session',
      'prompt',
      'worker',
      'Run persistence verification next',
      '--key',
      'persistence-follow-up',
    ])
    const answered = await cli('lead', [
      'session',
      'answer',
      'worker',
      '--input',
      'store-choice',
      'Settings',
      '--key',
      'storage-answer',
    ])
    expect(answered.ok).toBe(true)
    await expect
      .poll(
        async () =>
          prompts.some(
            (prompt) =>
              prompt.id === 'worker' &&
              prompt.text.includes('Also verify persistence') &&
              prompt.text.includes(String(note.result.messageId)),
          ),
        { timeout: 5_000 },
      )
      .toBe(true)
    await engine.quiesce('worker')
    const delivery = await cli('aria', [
      'session',
      'delivery',
      'worker',
      String(note.result.messageId),
    ])
    expect(delivery).toMatchObject({ ok: true, result: { status: 'delivered', consumedAt: null } })
    await cli('worker', ['session', 'ack', String(note.result.messageId), '--key', 'consumed-note'])
    expect(
      await cli('aria', ['session', 'delivery', 'worker', String(note.result.messageId)]),
    ).toMatchObject({ result: { status: 'consumed' } })
    await expect
      .poll(
        async () =>
          (await store.load('aria')).messages.some(
            (message) => message.origin?.kind === 'completion',
          ),
        { timeout: 5_000 },
      )
      .toBe(true)
  } finally {
    releaseLead()
    releaseWorker()
    await runtime?.close()
    await engine.shutdown()
    for (const id of ['aria', 'lead', 'worker']) await store.closeJournal(id)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

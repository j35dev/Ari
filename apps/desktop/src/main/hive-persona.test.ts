import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { BotStore } from '@ari/engine/bots'
import { controlPreamble } from '@ari/engine/control-preamble'
import { SessionStore } from '@ari/engine/session-store'
import type { AdapterSession } from '@ari/providers/driver'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'

const PERSONA = '# Pixel\n\nYou are Pixel, a careful UI engineer.'

let userData: string
let project: string
let store: SessionStore
let bots: BotStore
let seen: AdapterSession[]

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'ari-hive-user-'))
  project = await mkdtemp(join(tmpdir(), 'ari-hive-project-'))
  store = new SessionStore({ rootDir: join(userData, 'sessions') })
  bots = new BotStore({ dir: join(userData, 'bots') })
  seen = []
})

afterEach(async () => {
  for (const id of ['claude', 'codex']) await store.closeJournal(id)
  await rm(userData, { recursive: true, force: true, maxRetries: 3 })
  await rm(project, { recursive: true, force: true, maxRetries: 3 })
})

function engine(control: boolean): Engine {
  const registry = new DriverRegistry()
  const adapter = (session: AdapterSession) => {
    seen.push(session)
    return Promise.resolve({
      start: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'session-ref' as const, ref: `thread-${session.sessionId}` }
          yield { type: 'done' as const }
        },
      }),
      interrupt: () => undefined,
      dispose: async () => undefined,
    })
  }
  registry.register({ kind: 'claude', systemInstructions: true, create: adapter })
  registry.register({ kind: 'codex', create: adapter })
  return new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => project,
    runtimeEnvironment: async () => (control ? { ARI_ENV: '1' } : {}),
    botPersona: async (botId) => (await bots.get(botId))?.personaMd ?? null,
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
}

async function seed(driverKind: 'claude' | 'codex', botId?: string): Promise<Session> {
  const session: Session = {
    id: driverKind,
    projectId: 'p',
    title: driverKind,
    driverKind,
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...(botId ? { botId } : {}),
  }
  await store.append(driverKind, { type: 'session.created', session })
  return session
}

async function turn(target: Engine, sessionId: string, text: string): Promise<AdapterSession> {
  const before = seen.length
  await target.dispatch({ type: 'turn.start', sessionId, text, attachments: [] })
  await target.quiesce(sessionId)
  await expect.poll(async () => (await store.load(sessionId)).activeTurnId).toBeNull()
  return seen[before] as AdapterSession
}

describe.each([false, true])('a Hive bot session with the control env %s', (control) => {
  it('opens the system prompt with the persona', async () => {
    const bot = await bots.create({
      name: 'Pixel',
      emoji: '🎨',
      personaMd: PERSONA,
      driverKind: 'claude',
      modelId: null,
    })
    const target = engine(control)
    const session = await seed('claude', bot.id)

    for (const text of ['First', 'Second']) {
      const spawned = await turn(target, 'claude', text)
      expect(spawned.prompt).toBe(text)
      expect(spawned.instructions).toBe(
        control ? `${PERSONA}\n\n${controlPreamble(session, null, 'system')}` : PERSONA,
      )
    }
  })

  it('leads a fresh prompt with the persona when the driver has no system channel', async () => {
    const bot = await bots.create({
      name: 'Pixel',
      emoji: '🎨',
      personaMd: PERSONA,
      driverKind: 'codex',
      modelId: null,
    })
    const target = engine(control)
    const session = await seed('codex', bot.id)

    const fresh = await turn(target, 'codex', 'First')
    expect(fresh.instructions).toBeUndefined()
    expect(fresh.prompt).toBe(
      control
        ? `${PERSONA}\n\n${controlPreamble(session, null, 'prompt')}\n\nFirst`
        : `${PERSONA}\n\nFirst`,
    )
    expect((await turn(target, 'codex', 'Second')).prompt).toBe('Second')
  })

  it('writes nothing into the project folder', async () => {
    const bot = await bots.create({
      name: 'Pixel',
      emoji: '🎨',
      personaMd: PERSONA,
      driverKind: 'claude',
      modelId: null,
      projectId: 'p',
    })
    const target = engine(control)
    await seed('claude', bot.id)

    await turn(target, 'claude', 'First')
    expect(await readdir(project, { recursive: true })).toEqual([])
  })
})

describe.each([false, true])('a session without a bot, control env %s', (control) => {
  it('gets the same system prompt and first message as before bots existed', async () => {
    const target = engine(control)
    const claude = await seed('claude')
    const codex = await seed('codex')

    const system = await turn(target, 'claude', 'First')
    const prompt = await turn(target, 'codex', 'First')
    if (control) {
      expect(system.instructions).toBe(controlPreamble(claude, null, 'system'))
      expect(prompt.prompt).toBe(`${controlPreamble(codex, null, 'prompt')}\n\nFirst`)
    } else {
      expect(system.instructions).toBeUndefined()
      expect(prompt.prompt).toBe('First')
    }
    expect(system.prompt).toBe('First')
    expect(prompt.instructions).toBeUndefined()
  })
})

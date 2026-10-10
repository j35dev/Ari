import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { decideCommand } from './dispatcher'
import { DelegationSupervisor, type SupervisorHost } from './delegation-supervisor'
import { SessionStore } from './session-store'

let dir: string
let store: SessionStore
let host: SupervisorHost
let supervisor: DelegationSupervisor
let seq = 0
let policy = delegationSettingsSchema.parse({})
const waiting = new Set<string>()
const refuse = new Set<string>()

const session = (id: string, parentSessionId?: string): Session => ({
  id,
  projectId: 'p',
  title: id.toUpperCase(),
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  ...(parentSessionId ? { parentSessionId, rootSessionId: 'root' } : {}),
  createdAt: 1,
  updatedAt: 1,
})

async function create(id: string, parentSessionId?: string): Promise<void> {
  await store.append(id, { type: 'session.created', session: session(id, parentSessionId) })
}

async function start(id: string, text = 'go'): Promise<string> {
  await host.dispatch({ type: 'turn.start', sessionId: id, text, attachments: [] })
  return (await store.load(id)).activeTurnId!
}

/** Settles a turn the way the desktop engine does, mirroring it onto the parent. */
async function settle(
  id: string,
  stopReason: 'completed' | 'interrupted' | 'error' = 'completed',
  report?: string,
): Promise<string> {
  const model = await store.load(id)
  const turnId = model.activeTurnId!
  if (report)
    await store.append(id, {
      type: 'assistant.parts.appended',
      messageId: `reply-${turnId}`,
      parts: [{ type: 'text', text: report }],
    })
  await store.append(id, {
    type: 'turn.settled',
    turnId,
    stopReason,
    errorMessage: stopReason === 'error' ? 'boom' : null,
  })
  const parentId = model.session?.parentSessionId
  if (parentId)
    await store.append(parentId, {
      type: 'child.session.settled',
      childSessionId: id,
      turnId,
      stopReason,
    })
  return turnId
}

const notices = async (id: string) =>
  (await store.load(id)).messages.filter((message) => message.origin?.kind === 'completion')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-supervisor-'))
  store = new SessionStore({ rootDir: dir })
  policy = delegationSettingsSchema.parse({})
  waiting.clear()
  refuse.clear()
  host = {
    store,
    policy: () => policy,
    dispatch: async (command, origin) => {
      if (!('sessionId' in command)) return { accepted: false }
      if (refuse.has(command.sessionId)) return { accepted: false, reason: 'capacity' }
      const model = await store.load(command.sessionId)
      const decision = decideCommand(
        model,
        command,
        { turnId: `t${++seq}`, messageId: `m${seq}` },
        origin,
      )
      if (!decision.accepted) return decision
      for (const event of decision.events) await store.append(command.sessionId, event)
      const parentId = model.session?.parentSessionId
      if (command.type === 'turn.interrupt' && parentId && model.activeTurnId)
        await store.append(parentId, {
          type: 'child.session.settled',
          childSessionId: command.sessionId,
          turnId: model.activeTurnId,
          stopReason: 'interrupted',
        })
      return decision
    },
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    isWaiting: (parentId, childId) => waiting.has(`${parentId}:${childId}`),
    settleDelayMs: 60_000,
    retryDelayMs: 60_000,
  }
  supervisor = new DelegationSupervisor(host)
  await create('root')
  await create('a', 'root')
  await create('b', 'root')
})
afterEach(async () => {
  supervisor.close()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true })
})

it('wakes an idle parent once with every finished child and names the ones still working', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await start('b')
  await create('c', 'root')
  await start('c')
  await settle('a', 'completed', 'A is done.')
  await settle('b', 'error', 'B broke.')
  await supervisor.evaluate('root')

  const [notice] = await notices('root')
  expect(notice?.origin).toEqual({ kind: 'completion', sessionIds: ['a', 'b'] })
  const text = notice?.parts[0]?.type === 'text' ? notice.parts[0].text : ''
  expect(text).toContain('Child session "A" (a) finished its turn.\nReport:\nA is done.')
  expect(text).toContain('Child session "B" (b) failed.\nError: boom')
  expect(text).toContain('Still working: "C" (c)')
  expect((await store.load('root')).activeTurnId).not.toBeNull()

  await settle('root')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
})

it('holds a result while the parent is mid-turn and delivers it at the next clean settle', async () => {
  await start('root')
  await start('a')
  await settle('a', 'completed', 'Done.')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
  await settle('root')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
})

it('skips results the parent already read or is blocked waiting on', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await start('b')
  const read = await settle('a')
  await store.append('root', {
    type: 'child.session.acknowledged',
    childSessionId: 'a',
    turnId: read,
    via: 'wait',
  })
  await settle('b')
  waiting.add('root:b')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
  waiting.clear()
  await supervisor.evaluate('root')
  expect((await notices('root'))[0]?.origin).toEqual({ kind: 'completion', sessionIds: ['b'] })
})

it('leaves results pending behind a failed parent turn, a queue, or a child that resumed', async () => {
  await start('root')
  await settle('root', 'error')
  await start('a')
  await settle('a')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)

  await start('root')
  await host.dispatch({ type: 'message.enqueue', sessionId: 'root', text: 'next', attachments: [] })
  await settle('root')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)

  await host.dispatch({ type: 'message.dequeue', sessionId: 'root', text: 'next', attachments: [] })
  await start('a')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
  await settle('a')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
})

it('does nothing when delivery is switched off', async () => {
  policy = delegationSettingsSchema.parse({ autoDeliverResults: false })
  await start('root')
  await settle('root')
  await start('a')
  await settle('a')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
})

it('stops live children and drops pending results when the parent is stopped', async () => {
  supervisor.start()
  await create('grand', 'a')
  await start('root')
  await start('a')
  await start('b')
  await start('grand')
  await settle('b')
  await host.dispatch({ type: 'turn.interrupt', sessionId: 'root' })
  await expect
    .poll(async () => (await store.load('grand')).lastTurn?.stopReason)
    .toBe('interrupted')
  expect((await store.load('a')).lastTurn?.stopReason).toBe('interrupted')
  await expect
    .poll(async () =>
      Object.values((await store.load('root')).childCompletions ?? {}).every(
        (completion) => completion.acknowledged,
      ),
    )
    .toBe(true)

  await start('root')
  await settle('root')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
})

it('leaves children running when cascading stops is switched off', async () => {
  policy = delegationSettingsSchema.parse({ cascadeStop: false })
  supervisor.start()
  await start('root')
  await start('a')
  await host.dispatch({ type: 'turn.interrupt', sessionId: 'root' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect((await store.load('a')).activeTurnId).not.toBeNull()
})

it('retries a refused wake-up instead of acknowledging it', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await settle('a')
  refuse.add('root')
  await supervisor.evaluate('root')
  expect((await store.load('root')).childCompletions?.a?.acknowledged).toBe(false)
  refuse.clear()
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
})

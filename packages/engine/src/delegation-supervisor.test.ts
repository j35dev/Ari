import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { decideCommand } from './dispatcher'
import { DelegationSupervisor, type SupervisorHost } from './delegation-supervisor'
import { SessionStore } from './session-store'
import { turnRequester, helmSnapshot, helmReportRecipient } from './helm'

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

/** Starts a turn. A child's is prompted by its parent unless a person typed it. */
async function start(id: string, text = 'go', by: 'agent' | 'person' = 'agent'): Promise<string> {
  const parentId = (await store.load(id)).session?.parentSessionId
  await host.dispatch(
    { type: 'turn.start', sessionId: id, text, attachments: [] },
    by === 'agent' && parentId ? { kind: 'session', sessionId: parentId } : undefined,
  )
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
  const requester = await helmReportRecipient(store, model, turnId)
  if (
    requester &&
    requester !== parentId &&
    (await store.load(requester)).session?.projectId === 'helm'
  )
    await store.append(requester, {
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
    batchWindowMs: 0,
  }
  supervisor = new DelegationSupervisor(host)
  await create('root')
  await create('a', 'root')
  await create('b', 'root')
})
afterEach(async () => {
  await supervisor.close()
  for (const row of await store.listSessions()) await store.closeJournal(row.id)
  await rm(dir, { recursive: true, force: true })
})

it('recovers a delivered parent result after acknowledgement loss without resubmitting its notice', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await settle('a', 'completed', 'Reviewed output')
  const record = host.record.bind(host)
  host.record = async (id, event) => {
    if (event.type === 'child.session.acknowledged' && event.via === 'delivered')
      throw new Error('crash before acknowledgement')
    return record(id, event)
  }
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
  host.record = record
  await supervisor.close()
  await store.closeJournal('root')
  supervisor = new DelegationSupervisor(host)
  await supervisor.evaluate('root')
  expect((await store.load('root')).childCompletions?.a?.acknowledged).toBe(true)
  await settle('root')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
  expect(
    Object.values((await store.load('root')).orchestration?.operations ?? {}).filter(
      (entry) => entry.method === 'child.result.delivery',
    ),
  ).toMatchObject([{ status: 'completed' }])
})

it('leaves a result delivery with uncertain acceptance inspectable instead of replaying it', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await settle('a', 'completed', 'Output')
  const dispatch = host.dispatch.bind(host)
  host.dispatch = async (command, origin) => {
    if (origin?.kind === 'completion') throw new Error('unknown provider acceptance')
    return dispatch(command, origin)
  }
  await supervisor.evaluate('root')
  host.dispatch = dispatch
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
  expect((await store.load('root')).childCompletions?.a?.acknowledged).toBe(false)
  expect(Object.values((await store.load('root')).orchestration?.operations ?? {})).toMatchObject([
    { status: 'uncertain' },
  ])
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
  expect(notice?.origin).toMatchObject({ kind: 'completion', sessionIds: ['a', 'b'] })
  const text = notice?.parts[0]?.type === 'text' ? notice.parts[0].text : ''
  expect(text).toContain('A (a) finished its turn.\nReport:\nA is done.')
  expect(text).toContain('B (b) failed.\nError: boom')
  expect(text).toContain('Still working: C (c)')
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
  expect((await notices('root'))[0]?.origin).toMatchObject({
    kind: 'completion',
    sessionIds: ['b'],
  })
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

it('holds a report briefly while a sibling is about to finish, so both arrive together', async () => {
  let ahead = 0
  host.batchWindowMs = 20_000
  host.now = () => Date.now() + ahead
  await start('root')
  await settle('root')
  await start('a')
  await start('b')
  await settle('a', 'completed', 'A is done.')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)

  await settle('b', 'completed', 'B is done.')
  await supervisor.evaluate('root')
  expect((await notices('root'))[0]?.origin).toMatchObject({
    kind: 'completion',
    sessionIds: ['a', 'b'],
  })
  await settle('root')

  // The window is a ceiling, not a requirement: a slow sibling does not hold a result hostage,
  // and one parked on the user is not waited for at all.
  await start('a')
  await start('b')
  await settle('a', 'completed', 'A again.')
  ahead = 21_000
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(2)
  await settle('root')
  ahead = 0

  await start('a')
  await store.append('b', {
    type: 'approval.requested',
    approvalId: 'ap',
    toolName: 'Bash',
    summaryJson: '{}',
    options: [],
  })
  await settle('a', 'completed', 'A once more.')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(3)
})

it('does not wake an idle parent because someone stopped one of its children', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await start('b')
  await host.dispatch({ type: 'turn.interrupt', sessionId: 'a' })
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
  expect((await store.load('root')).childCompletions?.a?.acknowledged).toBe(true)

  // The stop is not held against later news: the other child still reports.
  await settle('b', 'completed', 'B is done.')
  await supervisor.evaluate('root')
  expect((await notices('root'))[0]?.origin).toMatchObject({
    kind: 'completion',
    sessionIds: ['b'],
  })
})

it('reaches a grandchild whose own parent already ended its turn, and wakes nobody afterwards', async () => {
  supervisor.start()
  await create('grand', 'a')
  await start('root')
  await start('a')
  await start('grand')
  // `a` handed its work out and ended its turn to wait, as it is told to.
  await settle('a', 'completed', 'Handed to grand.')
  await host.dispatch({ type: 'turn.interrupt', sessionId: 'root' })
  await expect
    .poll(async () => (await store.load('grand')).lastTurn?.stopReason)
    .toBe('interrupted')
  await expect
    .poll(async () => (await store.load('a')).childCompletions?.grand?.acknowledged)
    .toBe(true)
  await supervisor.evaluate('a')
  await supervisor.evaluate('root')
  expect(await notices('a')).toHaveLength(0)
  expect(await notices('root')).toHaveLength(0)
})

it('does not report a child as finished while work it delegated is still running', async () => {
  await create('grand', 'a')
  await start('root')
  await settle('root')
  await start('a')
  await start('grand')
  await settle('a', 'completed', 'Handed to grand.')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)

  // The grandchild reports to `a`, which then really finishes.
  await settle('grand', 'completed', 'Grand is done.')
  await supervisor.evaluate('a')
  expect(await notices('a')).toHaveLength(1)
  await settle('a', 'completed', 'All of it is done.')
  await supervisor.evaluate('root')
  const [notice] = await notices('root')
  expect(notice?.parts[0]?.type === 'text' && notice.parts[0].text).toContain('All of it is done.')
})

it('releases a held child once the work below it went quiet without waking it', async () => {
  await create('grand', 'a')
  await start('root')
  await settle('root')
  await start('a')
  await start('grand')
  await settle('a', 'completed', 'Handed to grand.')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)

  // Someone stops the grandchild: `a` is not woken, so its own report stands.
  await host.dispatch({ type: 'turn.interrupt', sessionId: 'grand' })
  await supervisor.evaluate('a')
  expect(await notices('a')).toHaveLength(0)
  await supervisor.evaluate('root')
  const [notice] = await notices('root')
  expect(notice?.parts[0]?.type === 'text' && notice.parts[0].text).toContain('Handed to grand.')
})

it('settles a child turn that a restart left open, and leaves a root alone', async () => {
  await start('root')
  await start('a')
  host.isRunning = () => false
  supervisor.start()
  await expect.poll(async () => (await store.load('a')).lastTurn?.stopReason).toBe('interrupted')
  expect((await store.load('root')).activeTurnId).not.toBeNull()
  expect((await store.load('b')).lastTurn).toBeUndefined()
})

it('repairs a child settlement whose parent mirror was lost before a restart', async () => {
  await start('root')
  await settle('root')
  const turnId = await start('a')
  const settled = await store.append('a', {
    type: 'turn.settled',
    turnId,
    stopReason: 'completed',
    errorMessage: null,
  })
  expect((await store.load('root')).childCompletions?.a).toBeUndefined()
  supervisor.start()
  await expect
    .poll(async () => (await store.load('root')).childCompletions?.a)
    .toMatchObject({ turnId, stopReason: 'completed', settledAt: settled.at, acknowledged: false })
  // Recover information, never replay old unattended work.
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
})

it('replays live settles that arrive during startup reconciliation instead of holding them as history', async () => {
  const list = store.listSessions.bind(store)
  let calls = 0
  let unblock!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    entered = resolve
  })
  store.listSessions = async () => {
    // The request supervisor subscribes/reads first; block delegation's inventory.
    if (++calls === 2) {
      entered()
      await gate
    }
    return list()
  }
  host.settleDelayMs = 5
  supervisor.start()
  await blocked
  await start('root')
  await settle('root')
  await start('a')
  await settle('a', 'completed', 'Finished during recovery')
  unblock()
  await expect.poll(async () => (await notices('root')).length).toBe(1)
  expect(JSON.stringify((await notices('root'))[0]?.parts)).toContain('Finished during recovery')
})

it('wakes a lead with a delegated child question, once, and never for a person’s child', async () => {
  await start('root')
  await start('a')
  supervisor.start()
  await store.append('a', {
    type: 'input.requested',
    inputId: 'q1',
    prompt: 'Which store?',
    choicesJson: JSON.stringify(['Settings', 'JSON file']),
  })
  await expect
    .poll(async () => Object.values((await store.load('root')).inbox ?? {}).length)
    .toBe(1)
  const [queued] = Object.values((await store.load('root')).inbox ?? {})
  expect(queued).toMatchObject({
    status: 'pending',
    senderSessionId: 'a',
    recipientSessionId: 'root',
  })
  expect(queued?.text).toContain('Which store?')
  expect(queued?.text).toContain('Settings / JSON file')
  expect(queued?.text).toContain('ari session answer a --input q1')

  // The provider may repeat a request; the lead is woken only once.
  await store.append('a', {
    type: 'input.requested',
    inputId: 'q1',
    prompt: 'Which store?',
    choicesJson: null,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(Object.values((await store.load('root')).inbox ?? {})).toHaveLength(1)

  // A question on a turn the person started stays with the person.
  await start('b', 'mine', 'person')
  await store.append('b', {
    type: 'input.requested',
    inputId: 'q2',
    prompt: 'Mine?',
    choicesJson: null,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(Object.values((await store.load('root')).inbox ?? {})).toHaveLength(1)
})

it('records interrupted turns after restart without replaying provider submissions', async () => {
  await start('root')
  await start('a')
  await start('b', 'mine', 'person')
  host.isRunning = () => false
  supervisor.start()
  await expect.poll(async () => (await store.load('a')).lastTurn?.stopReason).toBe('interrupted')
  await expect.poll(async () => (await store.load('b')).lastTurn?.stopReason).toBe('interrupted')

  expect((await store.load('a')).queuedMessages).toEqual([])
  expect((await store.load('b')).queuedMessages).toEqual([])
})

it('retains historical reports without starting unattended provider turns', async () => {
  // Also the shape every journal from before delivery existed is in: a
  // settled child and nothing that says the parent has seen it.
  await start('root')
  await settle('root')
  await start('a')
  await settle('a', 'completed', 'A finished last week.')
  await start('b')
  host.isRunning = () => false
  host.settleDelayMs = 5
  supervisor.start()

  await expect.poll(async () => (await store.load('b')).lastTurn?.stopReason).toBe('interrupted')
  await expect
    .poll(async () => (await store.load('root')).childCompletions?.a?.acknowledged)
    .toBe(false)
  // The user's next message in the old session is answered once, not twice.
  await start('root')
  await settle('root')
  await supervisor.evaluate('root')
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(await notices('root')).toHaveLength(0)
})

it('does not wake the parent for a turn a person ran in the child', async () => {
  await start('root')
  await settle('root')
  await start('a', 'one more thing', 'person')
  await settle('a', 'completed', 'Answered the person.')
  await supervisor.evaluate('root')

  expect(await notices('root')).toHaveLength(0)
  expect((await store.load('root')).childCompletions?.a?.acknowledged).toBe(true)
})

it('stops everything below an idle parent without waking it for what had finished', async () => {
  await start('root')
  await settle('root')
  await start('a')
  await start('b')
  await settle('a', 'completed', 'A is done.')

  expect(await supervisor.stopBelow('root')).toBe(1)
  expect((await store.load('b')).lastTurn?.stopReason).toBe('interrupted')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(0)
  expect((await store.load('root')).activeTurnId).toBeNull()
  expect(await supervisor.stopBelow('root')).toBe(0)
})

it('stops a grandchild under an idle child, and leaves a running parent alone', async () => {
  await start('root')
  await start('a')
  await start('b')
  await settle('b')
  await create('grand', 'b')
  await start('grand')

  expect(await supervisor.stopBelow('root')).toBe(2)
  expect((await store.load('a')).lastTurn?.stopReason).toBe('interrupted')
  expect((await store.load('grand')).lastTurn?.stopReason).toBe('interrupted')
  expect((await store.load('root')).activeTurnId).not.toBeNull()
})

it('tries a refused wake-up again when any turn settles', async () => {
  host.settleDelayMs = 5
  supervisor.start()
  await start('root')
  await settle('root')
  await start('a')
  refuse.add('root')
  await settle('a', 'completed', 'A is done.')
  await expect
    .poll(async () => (await store.load('root')).childCompletions?.a?.stopReason)
    .toBe('completed')
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(await notices('root')).toHaveLength(0)

  refuse.clear()
  await start('b')
  await host.dispatch({ type: 'turn.interrupt', sessionId: 'b' })
  await expect.poll(async () => (await notices('root')).length).toBe(1)
  // Seeing the notice precedes its acknowledgement and delivery receipt.
  // Stop new schedules and finish the existing serialized writes before teardown.
  await supervisor.close()
  await supervisor.evaluate('root')
  await supervisor.evaluate('b')
  expect((await store.load('root')).childCompletions?.a?.acknowledged).toBe(true)
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

it('wakes Aria with the report of a turn it asked for in another project', async () => {
  await store.append('helm1', {
    type: 'session.created',
    session: { ...session('helm1'), projectId: 'helm' },
  })
  await start('helm1')
  await settle('helm1')
  // Aria prompted a child of another session; the turn is Aria's to hear about.
  await host.dispatch(
    { type: 'turn.start', sessionId: 'a', text: 'Check the limiter', attachments: [] },
    { kind: 'session', sessionId: 'helm1' },
  )
  const turnId = await settle('a', 'completed', 'Limiter checked')
  await store.append('helm1', {
    type: 'child.session.settled',
    childSessionId: 'a',
    turnId,
    stopReason: 'completed',
  })
  await start('root')
  await settle('root')
  await supervisor.evaluate('root')
  await supervisor.evaluate('helm1')
  const helmNotices = await notices('helm1')
  expect(helmNotices).toHaveLength(1)
  expect(JSON.stringify(helmNotices[0]?.parts)).toContain('Limiter checked')
  // The parent did not ask, so it is not woken.
  expect(await notices('root')).toHaveLength(0)
  expect((await store.load('root')).childCompletions?.['a']?.acknowledged).toBe(true)
})

async function createAria(): Promise<void> {
  await store.append('helm1', {
    type: 'session.created',
    session: { ...session('helm1'), projectId: 'helm' },
  })
  await start('helm1')
  await settle('helm1')
}

async function askByAria(id: string): Promise<void> {
  await host.dispatch(
    { type: 'turn.start', sessionId: id, text: 'Project work', attachments: [] },
    { kind: 'session', sessionId: 'helm1' },
  )
}

it('holds a top-level lead report through running workers and delivers only the lead completion-wake result', async () => {
  await createAria()
  await store.append('lead', {
    type: 'session.created',
    session: { ...session('lead'), lead: true, createdBy: { kind: 'session', sessionId: 'helm1' } },
  })
  await create('worker', 'lead')
  await askByAria('lead')
  await start('worker')
  await settle('lead', 'completed', 'Handed out the work.')
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(0)
  await settle('worker', 'completed', 'Implemented and tested.')
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(0)
  await supervisor.evaluate('lead')
  expect(await notices('lead')).toHaveLength(1)
  expect((await store.load('lead')).activeTurnId).not.toBeNull()
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(0)
  const wakeTurn = (await store.load('lead')).activeTurnId!
  expect(turnRequester(await store.load('lead'), wakeTurn)).toBe('helm1')
  await settle('lead', 'completed', 'Integrated worker changes and verified the project.')
  await supervisor.evaluate('lead')
  await supervisor.evaluate('helm1')
  const reports = await notices('helm1')
  expect(reports).toHaveLength(1)
  expect(JSON.stringify(reports[0]?.parts)).toContain('Integrated worker changes')
  expect(JSON.stringify(reports[0]?.parts)).not.toContain('Handed out')
  expect(reports[0]?.origin).toMatchObject({ kind: 'completion', sessionIds: ['lead'] })
  expect((await store.load('helm1')).childCompletions?.worker).toBeUndefined()
})

it('bubbles a held project lead report to the current Aria after its requester is deleted', async () => {
  await createAria()
  await store.append('lead', {
    type: 'session.created',
    session: {
      ...session('lead'),
      lead: true,
      createdBy: { kind: 'session', sessionId: 'helm1' },
    },
  })
  await create('worker', 'lead')
  await askByAria('lead')
  await start('worker')
  await store.destroy('helm1')
  await store.append('helm2', {
    type: 'session.created',
    session: { ...session('helm2'), projectId: 'helm' },
  })
  await start('helm2')
  await settle('helm2')
  await settle('lead', 'completed', 'Lead report')
  await supervisor.evaluate('helm2')
  expect(await notices('helm2')).toHaveLength(0)
  await settle('worker', 'interrupted')
  const scheduled = vi.spyOn(supervisor, 'schedule')
  await supervisor.evaluate('lead')
  expect(scheduled).toHaveBeenCalledWith('helm2')
  await supervisor.evaluate('helm2')
  expect(await notices('helm2')).toHaveLength(1)
  expect(JSON.stringify((await notices('helm2'))[0]?.parts)).toContain('Lead report')
  scheduled.mockRestore()
})

it('marks a quiet Aria report handled, keeps it readable and visible, and never delivers it later', async () => {
  await createAria()
  await askByAria('a')
  await settle('a', 'completed', 'Checks passed.\n<!-- aria: fyi -->')
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(0)
  expect((await store.load('helm1')).childCompletions?.a?.acknowledged).toBe(true)
  const snapshot = await helmSnapshot(
    {
      rows: await store.listSessions(),
      load: (id) => store.load(id),
      projectName: () => 'Project',
    },
    await store.load('helm1'),
    [],
  )
  expect(snapshot).toContain('Finished in the last day')
  expect(snapshot).toContain('"A"')
  expect(JSON.stringify((await store.load('a')).messages)).toContain('Checks passed.')
  await start('helm1')
  await settle('helm1')
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(0)
  // The marker only suppresses an Aria receiver, never the worker's lead.
  await start('root')
  await settle('root')
  await start('b')
  await settle('b', 'completed', 'Worker done.\n<!-- aria: fyi -->')
  await supervisor.evaluate('root')
  expect(await notices('root')).toHaveLength(1)
})

it.each([
  ['completed', 'Need your decision.\n<!-- aria: fyi -->'],
  ['completed', 'Which path?\n<!-- aria: fyi -->'],
  ['completed', 'Done.\n<!-- aria: fyi --> '],
  ['error', 'Routine report.\n<!-- aria: fyi -->'],
  ['completed', `${'Routine output. '.repeat(400)}\nQuestion?\n<!-- aria: fyi -->`],
] as const)('wakes Aria for a wrongly marked report: %s', async (reason, report) => {
  await createAria()
  await askByAria('a')
  await settle('a', reason, report)
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(1)
})

it('allows eight automatic Aria turns, holds the ninth report across restart, and releases it after a human message', async () => {
  await createAria()
  for (let i = 0; i < 8; i++) {
    await askByAria('a')
    await settle('a', 'completed', `Result ${i}`)
    await supervisor.evaluate('helm1')
    expect(await notices('helm1')).toHaveLength(i + 1)
    await settle('helm1')
  }
  await askByAria('a')
  await settle('a', 'completed', 'Ninth result')
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(8)
  expect((await store.load('helm1')).childCompletions?.a?.acknowledged).toBe(false)
  await supervisor.close()
  supervisor = new DelegationSupervisor(host)
  host.isRunning = () => false
  supervisor.start()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(8)
  await start('helm1', 'Continue', 'person')
  await settle('helm1')
  await supervisor.evaluate('helm1')
  expect(await notices('helm1')).toHaveLength(9)
  expect(JSON.stringify((await notices('helm1'))[8]?.parts)).toContain('Ninth result')
  expect((await store.load('helm1')).childCompletions?.a?.acknowledged).toBe(true)
})

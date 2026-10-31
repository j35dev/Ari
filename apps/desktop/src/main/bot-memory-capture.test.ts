// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { BotMemoryStore } from '@ari/engine/bot-memory'
import { SessionStore } from '@ari/engine/session-store'
import { BotMemoryCapture } from './bot-memory-capture'

let dir: string
let store: SessionStore
let memory: BotMemoryStore
let capture: BotMemoryCapture
let now: number
let enabled: boolean
let sent: { command: Command; origin: MessageOrigin | undefined }[]

const make = (): BotMemoryCapture =>
  new BotMemoryCapture({
    store,
    memory,
    now: () => now,
    dispatch: async (command, origin) => {
      sent.push({ command, origin })
      return { accepted: true }
    },
    enabled: () => enabled,
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-bot-memory-'))
  store = new SessionStore({ rootDir: join(dir, 'sessions') })
  memory = new BotMemoryStore({ dir: join(dir, 'memory') })
  await store.append('sess_bot', {
    type: 'session.created',
    session: {
      id: 'sess_bot',
      projectId: 'p',
      title: 'Forge',
      driverKind: 'ari-core',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      botId: 'bot_1',
    },
  })
  await store.append('sess_person', {
    type: 'session.created',
    session: {
      id: 'sess_person',
      projectId: 'p',
      title: 'Manual work',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
  })
  now = 1_000
  enabled = true
  sent = []
  capture = make()
})

afterEach(async () => {
  capture.close()
  await store.closeJournal('sess_bot')
  await store.closeJournal('sess_person')
  await rm(dir, { recursive: true, force: true })
})

/** A settled human turn in the bot's session. */
async function humanTurn(turnId: string): Promise<void> {
  await store.append('sess_bot', { type: 'turn.started', turnId })
  await store.append('sess_bot', {
    type: 'user.message.added',
    message: {
      id: `m_${turnId}`,
      sessionId: 'sess_bot',
      turnId,
      role: 'user',
      origin: { kind: 'human' },
      parts: [{ type: 'text', text: 'please fix it' }],
      createdAt: 2,
    },
  })
  await store.append('sess_bot', {
    type: 'turn.settled',
    turnId,
    stopReason: 'completed',
    errorMessage: null,
  })
}

it('fires one capture after a settled human turn in a bot session', async () => {
  await memory.add('bot_1', 'Prefers small diffs.')
  await humanTurn('turn_1')
  await capture.consider('sess_bot')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.origin).toEqual({ kind: 'memory-capture' })
  const text = sent[0]?.command.type === 'message.enqueue' ? sent[0].command.text : ''
  expect(text).toContain('Prefers small diffs.')
  expect(sent[0]?.command).toMatchObject({
    type: 'message.enqueue',
    sessionId: 'sess_bot',
    hold: true,
    priority: 'routine',
  })
})

it('listens through the session store subscription', async () => {
  capture.start(store)
  await humanTurn('turn_1')
  await capture.consider('sess_bot')
  expect(sent).toHaveLength(1)
})

it('skips sessions that are not bots and honours the opt-in setting', async () => {
  enabled = false
  await humanTurn('turn_1')
  await capture.consider('sess_bot')
  capture.close()

  enabled = true
  capture = make()
  await capture.consider('sess_person')
  expect(sent).toHaveLength(0)
})

it('rests after a capture: no refire on the next settled event', async () => {
  await humanTurn('turn_1')
  await capture.consider('sess_bot')
  expect(sent).toHaveLength(1)
  await humanTurn('turn_2')
  await capture.consider('sess_bot')
  expect(sent).toHaveLength(1)
})

it('lets the next capture run once the throttle interval has passed', async () => {
  await humanTurn('turn_1')
  await capture.consider('sess_bot')
  expect(sent).toHaveLength(1)
  await humanTurn('turn_2')
  now += 15 * 60_000
  await capture.consider('sess_bot')
  expect(sent).toHaveLength(2)
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Message, MessageOrigin } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import {
  MEMORY_CAPTURE_MIN_EVERY_MS,
  latestCaptureTurnId,
  memoryCaptureDue,
  memoryCapturePrompt,
} from './bot-memory-capture'
import { initialReadModel, type SessionReadModel } from './projection'
import type { QueuedMessage } from '@ari/contracts/attachments'

const SESSION: Session = {
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
}

const humanMessage = (id: string, turnId: string): Message => ({
  id,
  sessionId: 'sess_bot',
  turnId,
  role: 'user',
  origin: { kind: 'human' },
  parts: [{ type: 'text', text: 'please fix it' }],
  createdAt: 2,
})

const captureMessage = (id: string, turnId: string): Message => ({
  id,
  sessionId: 'sess_bot',
  turnId,
  role: 'user',
  origin: { kind: 'memory-capture' },
  parts: [{ type: 'text', text: '[Memory capture.' }],
  createdAt: 3,
})

const queuedCapture = (): QueuedMessage => ({
  origin: { kind: 'memory-capture' },
  text: '[Memory capture.',
  attachments: [],
  held: true,
  priority: 'routine',
})

const model = (over: Partial<SessionReadModel>): SessionReadModel => ({
  ...initialReadModel(),
  session: SESSION,
  ...over,
})

describe('memoryCapturePrompt', () => {
  it('inlines the current memory and asks for silence', () => {
    const prompt = memoryCapturePrompt('Prefers small diffs.\n')
    expect(prompt).toContain('Prefers small diffs.')
    expect(prompt).toContain('memory.add')
    expect(prompt).toContain('no text at all')
  })
  it('shows empty memory as a word, not a blank', () => {
    expect(memoryCapturePrompt('   \n')).toContain('(empty)')
  })
})

describe('latestCaptureTurnId', () => {
  it('finds the last capture turn, newest first', () => {
    expect(
      latestCaptureTurnId(
        model({
          messages: [humanMessage('m1', 'turn_1'), captureMessage('m2', 'turn_2')],
        }),
      ),
    ).toBe('turn_2')
  })
  it('answers null without captures', () => {
    expect(latestCaptureTurnId(model({ messages: [humanMessage('m1', 'turn_1')] }))).toBeNull()
  })
})

describe('memoryCaptureDue', () => {
  const now = 600_000

  it('fires after a settled human turn, first time', () => {
    expect(
      memoryCaptureDue(model({ messages: [humanMessage('m1', 'turn_1')] }), undefined, now),
    ).toBe(true)
  })

  it('waits while a turn is running or a capture is queued', () => {
    expect(
      memoryCaptureDue(
        model({ messages: [humanMessage('m1', 'turn_1')], activeTurnId: 'turn_1' }),
        undefined,
        now,
      ),
    ).toBe(false)
    expect(
      memoryCaptureDue(
        model({ messages: [humanMessage('m1', 'turn_1')], queuedMessages: [queuedCapture()] }),
        undefined,
        now,
      ),
    ).toBe(false)
  })

  it('needs a fresh human or room message since the last capture', () => {
    const captured = model({
      messages: [humanMessage('m1', 'turn_1'), captureMessage('m2', 'turn_2')],
    })
    expect(memoryCaptureDue(captured, undefined, now)).toBe(false)
    const talked = model({
      messages: [
        humanMessage('m1', 'turn_1'),
        captureMessage('m2', 'turn_2'),
        humanMessage('m3', 'turn_3'),
      ],
    })
    expect(memoryCaptureDue(talked, undefined, now)).toBe(true)
  })

  it('throttles repeats until the interval has passed', () => {
    const talked = model({ messages: [humanMessage('m1', 'turn_1')] })
    expect(memoryCaptureDue(talked, now - MEMORY_CAPTURE_MIN_EVERY_MS + 1, now)).toBe(false)
    expect(memoryCaptureDue(talked, now - MEMORY_CAPTURE_MIN_EVERY_MS, now)).toBe(true)
  })

  it('ignores routine chatter as content worth capturing', () => {
    const routineMessage: Message = {
      ...humanMessage('m1', 'turn_1'),
      origin: { kind: 'routine', routineId: 'routine_1' },
    }
    expect(memoryCaptureDue(model({ messages: [routineMessage] }), undefined, now)).toBe(false)
  })

  it('covers the origin union: completion messages do not count', () => {
    const origin: MessageOrigin = { kind: 'completion', sessionIds: ['sess_c'] }
    const completion: Message = { ...humanMessage('m1', 'turn_1'), origin }
    expect(memoryCaptureDue(model({ messages: [completion] }), undefined, now)).toBe(false)
  })
})

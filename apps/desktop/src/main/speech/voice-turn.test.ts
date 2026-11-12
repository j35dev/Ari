// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { VoiceTurn } from './voice-turn'

function event(type: string, fields: object = {}): JournalEvent {
  return { type, sessionId: 'aria', seq: 1, at: 0, ...fields } as JournalEvent
}
const request = event('user.message.added', {
  message: {
    turnId: 'turn',
    parts: [{ type: 'text', text: 'Run checks' }],
    origin: { kind: 'human' },
  },
})
const final = event('assistant.parts.appended', {
  messageId: 'reply',
  parts: [
    { type: 'text', text: '<!-- aria:speak {"text":"The checks passed."} -->\nDetails follow.' },
  ],
})
it('speaks an authored final exactly once for the armed voice turn', () => {
  const speak = vi.fn()
  const turn = new VoiceTurn(speak, () => true)
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.observe(final)
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'completed' }))
  expect(speak).toHaveBeenCalledTimes(1)
})
it('keeps typed messages progress background turns and interrupted replies quiet', () => {
  const speak = vi.fn()
  const turn = new VoiceTurn(speak, () => true)
  turn.observe(request)
  turn.observe(final)
  expect(speak).not.toHaveBeenCalled()
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.observe(
    event('assistant.parts.appended', { parts: [{ type: 'text', text: 'Running the checks.' }] }),
  )
  expect(speak).not.toHaveBeenCalled()
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'interrupted' }))
  expect(speak).not.toHaveBeenCalled()
})
it('falls back on completion and clears after a new hold or disabling Aria', () => {
  const speak = vi.fn()
  const turn = new VoiceTurn(speak, () => true)
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.observe(
    event('assistant.parts.appended', { parts: [{ type: 'text', text: 'The checks passed.' }] }),
  )
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'completed' }))
  expect(speak).toHaveBeenCalledWith('The checks passed.', false)
  speak.mockClear()
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.clear()
  turn.observe(final)
  expect(speak).not.toHaveBeenCalled()
})
it('says each passage as it ends, in order, queueing the later ones', () => {
  const speak = vi.fn()
  const turn = new VoiceTurn(speak, () => true)
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  // What she writes before reaching for a tool is said when the tool starts.
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'progress',
      parts: [{ type: 'text', text: 'Finding the sessions ' }],
    }),
  )
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'progress',
      parts: [{ type: 'text', text: 'to delete.' }],
    }),
  )
  expect(speak).not.toHaveBeenCalled()
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'progress',
      parts: [{ type: 'tool-call', toolCallId: 't', toolName: 'shell', input: {} }],
    }),
  )
  expect(speak).toHaveBeenCalledTimes(1)
  expect(speak).toHaveBeenLastCalledWith('Finding the sessions to delete.', false)
  // A tool result carries no words and says nothing.
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'progress',
      parts: [{ type: 'tool-result', toolCallId: 't', output: 'ok' }],
    }),
  )
  expect(speak).toHaveBeenCalledTimes(1)
  // The next message is said when the turn settles, behind the first.
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'final',
      parts: [{ type: 'text', text: 'Four sessions are gone.' }],
    }),
  )
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'completed' }))
  expect(speak).toHaveBeenCalledTimes(2)
  expect(speak).toHaveBeenLastCalledWith('Four sessions are gone.', true)
})
it('says an authored final as soon as its spoken line arrives, once, after the progress', () => {
  const speak = vi.fn()
  const turn = new VoiceTurn(speak, () => true)
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'progress',
      parts: [{ type: 'text', text: 'Running the checks.' }],
    }),
  )
  // A new message ends the passage before it.
  turn.observe(final)
  expect(speak).toHaveBeenCalledTimes(2)
  expect(speak).toHaveBeenNthCalledWith(1, 'Running the checks.', false)
  expect(speak.mock.calls[1]?.[1]).toBe(true)
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'reply',
      parts: [{ type: 'text', text: ' More written detail.' }],
    }),
  )
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'completed' }))
  expect(speak).toHaveBeenCalledTimes(2)
})
it('adds nothing when a turn is interrupted after progress was spoken', () => {
  const speak = vi.fn()
  const turn = new VoiceTurn(speak, () => true)
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'progress',
      parts: [
        { type: 'text', text: 'Running the checks.' },
        { type: 'tool-call', toolCallId: 't', toolName: 'shell', input: {} },
        { type: 'text', text: 'Half a thou' },
      ],
    }),
  )
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'interrupted' }))
  expect(speak).toHaveBeenCalledTimes(1)
})

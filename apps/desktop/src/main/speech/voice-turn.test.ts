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
  expect(speak).toHaveBeenCalledWith('The checks passed.')
  speak.mockClear()
  turn.arm('aria', 'Run checks')
  turn.observe(request)
  turn.clear()
  turn.observe(final)
  expect(speak).not.toHaveBeenCalled()
})
it('condenses the final message without reading earlier commentary', () => {
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
  turn.observe(
    event('assistant.parts.appended', {
      messageId: 'final',
      parts: [{ type: 'text', text: 'The checks passed.' }],
    }),
  )
  turn.observe(event('turn.settled', { turnId: 'turn', stopReason: 'completed' }))
  expect(speak).toHaveBeenCalledWith('The checks passed.')
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  HoldToTalk,
  MODIFIER_HOLD_MS,
  RECORDING_LIMIT_MS,
  SENT_MS,
  TRANSCRIPTION_LIMIT_MS,
} from './model'

describe('hold to talk', () => {
  it('records a modifier hold immediately, reveals after the delay and transcribes on release', () => {
    const flow = new HoldToTalk()
    flow.down(0, MODIFIER_HOLD_MS)
    expect(flow.state.phase).toBe('listening')
    expect(flow.visible(MODIFIER_HOLD_MS - 1)).toBe(false)
    expect(flow.visible(MODIFIER_HOLD_MS)).toBe(true)
    flow.up(MODIFIER_HOLD_MS)
    expect(flow.state.phase).toBe('transcribing')
  })

  it('cancels a short modifier tap without ever revealing or transcribing', () => {
    const flow = new HoldToTalk()
    flow.down(0, MODIFIER_HOLD_MS)
    flow.up(MODIFIER_HOLD_MS - 1)
    expect(flow.state.phase).toBe('hidden')
    expect(flow.visible(MODIFIER_HOLD_MS)).toBe(false)
    flow.finish(1, 'Never send this', MODIFIER_HOLD_MS)
    expect(flow.state.phase).toBe('hidden')
  })

  it('keeps recording failures hidden during the modifier grace period and cancels them on a tap', () => {
    const flow = new HoldToTalk()
    flow.down(0, MODIFIER_HOLD_MS)
    flow.error(1, 'Microphone unavailable', false, 10)
    expect(flow.visible(10)).toBe(false)
    flow.up(20)
    expect(flow.state.phase).toBe('hidden')
    expect(flow.visible(MODIFIER_HOLD_MS)).toBe(false)
  })

  it('listens once per hold, transcribes on release and hides after sent', () => {
    const flow = new HoldToTalk()
    expect(flow.down(0)).toBe(true)
    expect(flow.down(1)).toBe(false)
    expect(flow.state.phase).toBe('listening')
    flow.up(10)
    expect(flow.down(11)).toBe(false)
    flow.finish(1, '  Fix\n the build  ', 20)
    expect(flow.state).toMatchObject({ phase: 'sent', text: 'Fix the build' })
    flow.tick(20 + SENT_MS - 1)
    expect(flow.state.phase).toBe('sent')
    flow.tick(20 + SENT_MS)
    expect(flow.state.phase).toBe('hidden')
  })

  it('cancels quietly and ignores releases and results from a cancelled hold', () => {
    const flow = new HoldToTalk()
    flow.down(0)
    flow.cancel()
    flow.up(10)
    flow.finish(1, 'Do not send', 20)
    expect(flow.state.phase).toBe('hidden')
    flow.down(30)
    flow.up(40)
    flow.finish(1, 'Old message', 50)
    expect(flow.state.phase).toBe('transcribing')
    flow.finish(2, '', 60)
    expect(flow.state.phase).toBe('hidden')
  })

  it.each([
    ['listening', RECORDING_LIMIT_MS],
    ['transcribing', TRANSCRIPTION_LIMIT_MS],
  ] as const)('times out %s and ignores its late result', (phase, timeout) => {
    const flow = new HoldToTalk()
    flow.down(0)
    if (phase === 'transcribing') flow.up(0)
    flow.tick(timeout)
    expect(flow.state).toMatchObject({ phase: 'error', text: 'Speech timed out. Try again.' })
    flow.finish(1, 'Late speech', timeout + 1)
    expect(flow.state.phase).toBe('error')
    flow.tick(timeout + 6_000)
    expect(flow.state.phase).toBe('hidden')
  })

  it('keeps a clickable setup hint after readiness fails on an armed press', () => {
    const flow = new HoldToTalk()
    flow.down(0)
    flow.error(1, 'Set up speech to text in Settings', true, 1)
    flow.up(2)
    expect(flow.state).toMatchObject({ phase: 'error', setup: true })
  })
})

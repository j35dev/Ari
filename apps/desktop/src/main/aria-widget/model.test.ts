// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HoldToTalk, RECORDING_LIMIT_MS, SENT_MS, TRANSCRIPTION_LIMIT_MS } from './model'

describe('hold to talk', () => {
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

  it('ignores new holds and releases during transcription or sending', () => {
    const flow = new HoldToTalk()
    flow.down(0)
    flow.up(1)
    const previous = flow.state
    const deadline = flow.expiresAt
    expect(flow.canStart).toBe(false)
    expect(flow.down(3)).toBe(false)
    flow.up(4)
    expect(flow.state).toBe(previous)
    expect(flow.expiresAt).toBe(deadline)
  })

  it.each(['sent', 'error', 'setup'] as const)('replaces a %s pill with a new hold', (phase) => {
    const flow = new HoldToTalk()
    flow.down(0)
    if (phase === 'sent') {
      flow.up(1)
      flow.finish(1, 'Previous result', 2)
    } else flow.error(1, 'Previous hint', phase === 'setup', 2)
    expect(flow.canStart).toBe(true)
    expect(flow.down(3)).toBe(true)
    expect(flow.state).toEqual({ id: 2, phase: 'listening', text: '', setup: false })
    expect(flow.expiresAt).toBe(3 + RECORDING_LIMIT_MS)
    flow.finish(1, 'Late result', 4)
    flow.error(1, 'Late error', true, 4)
    expect(flow.state).toEqual({ id: 2, phase: 'listening', text: '', setup: false })
  })

  it('cancels quietly and ignores results from a cancelled hold', () => {
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
    flow.tick(timeout + 6000)
    expect(flow.state.phase).toBe('hidden')
  })

  it('keeps a clickable setup hint after readiness fails on a press', () => {
    const flow = new HoldToTalk()
    flow.down(0)
    flow.error(1, 'Set up speech to text in Settings', true, 1)
    flow.up(2)
    expect(flow.state).toMatchObject({ phase: 'error', setup: true })
  })
})

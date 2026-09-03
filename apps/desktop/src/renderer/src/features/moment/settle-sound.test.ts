import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playSettleSound } from './settle-sound'

/**
 * Minimal Web Audio stubs: nodes record their scheduling calls so tests can
 * assert on frequencies and envelopes without a real audio device.
 */
function makeFakeParam() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  }
}

interface FakeOscillator {
  type: string
  frequency: ReturnType<typeof makeFakeParam>
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static ctorError: Error | null = null

  currentTime = 100
  destination = { toString: () => 'destination' }
  oscillators: FakeOscillator[] = []
  closed = false
  resume = vi.fn(() => Promise.resolve())

  constructor() {
    if (FakeAudioContext.ctorError) throw FakeAudioContext.ctorError
    FakeAudioContext.instances.push(this)
  }

  createOscillator(): FakeOscillator {
    const osc: FakeOscillator = {
      type: 'sine',
      frequency: makeFakeParam(),
      connect: vi.fn(() => ({ connect: vi.fn() })),
      start: vi.fn(),
      stop: vi.fn(),
    }
    this.oscillators.push(osc)
    return osc
  }

  createGain() {
    return { gain: makeFakeParam(), connect: vi.fn() }
  }

  close() {
    this.closed = true
    return Promise.resolve()
  }
}

/** Frequencies (Hz) each cue schedules, in oscillator order. */
function scheduledFreqs(ctx: FakeAudioContext): number[] {
  return ctx.oscillators.map((osc) =>
    osc.frequency.setValueAtTime.mock.calls[0]?.[0] as number,
  )
}

/** The one context a play call should have created. */
function soleContext(): FakeAudioContext {
  const ctx = FakeAudioContext.instances[0]
  if (ctx === undefined) throw new Error('playSettleSound created no AudioContext')
  return ctx
}

describe('playSettleSound', () => {
  beforeEach(() => {
    FakeAudioContext.instances = []
    FakeAudioContext.ctorError = null
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('plays a rising fifth for a completed turn', () => {
    playSettleSound('complete')
    const ctx = soleContext()
    expect(ctx.oscillators).toHaveLength(2)
    expect(scheduledFreqs(ctx)).toEqual([587.33, 880])
  })

  it('plays a quieter falling third for a failed turn', () => {
    playSettleSound('error')
    const ctx = soleContext()
    expect(ctx.oscillators).toHaveLength(2)
    expect(scheduledFreqs(ctx)).toEqual([392, 311.13])
  })

  it('plays a distinct higher fifth when the agent needs attention', () => {
    playSettleSound('attention')
    const ctx = soleContext()
    expect(ctx.oscillators).toHaveLength(2)
    expect(scheduledFreqs(ctx)).toEqual([783.99, 1174.66])
  })

  it('resumes the context so a suspended start still sounds', () => {
    playSettleSound('complete')
    expect(soleContext().resume).toHaveBeenCalledTimes(1)
  })

  it('swallows a missing AudioContext without throwing', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(() => playSettleSound('complete')).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('swallows a constructor failure without throwing', () => {
    FakeAudioContext.ctorError = new Error('audio device gone')
    expect(() => playSettleSound('error')).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(0)
  })
})

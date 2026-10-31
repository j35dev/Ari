import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playSettleSound } from './settle-sound'

const logs = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('@ari/shared/logger', () => ({ createLogger: () => logs }))

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

interface FakeGain {
  gain: ReturnType<typeof makeFakeParam>
  connect: ReturnType<typeof vi.fn>
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static ctorError: Error | null = null
  static resumeError: Error | null = null
  static resumeThrows = false
  static closeError: Error | null = null
  static scheduleError: Error | null = null

  currentTime = 100
  destination = { toString: () => 'destination' }
  oscillators: FakeOscillator[] = []
  gains: FakeGain[] = []
  closed = false
  resume = vi.fn(() => {
    if (FakeAudioContext.resumeThrows) throw new Error('resume failed')
    if (FakeAudioContext.resumeError) return Promise.reject(FakeAudioContext.resumeError)
    return Promise.resolve()
  })

  constructor() {
    if (FakeAudioContext.ctorError) throw FakeAudioContext.ctorError
    FakeAudioContext.instances.push(this)
  }

  createOscillator(): FakeOscillator {
    if (FakeAudioContext.scheduleError && this.oscillators.length === 1) {
      throw FakeAudioContext.scheduleError
    }
    const osc: FakeOscillator = {
      type: 'sine',
      frequency: makeFakeParam(),
      connect: vi.fn((target: FakeGain) => target),
      start: vi.fn(),
      stop: vi.fn(),
    }
    this.oscillators.push(osc)
    return osc
  }

  createGain(): FakeGain {
    const gain = { gain: makeFakeParam(), connect: vi.fn() }
    this.gains.push(gain)
    return gain
  }

  close = vi.fn(() => {
    this.closed = true
    if (FakeAudioContext.closeError) return Promise.reject(FakeAudioContext.closeError)
    return Promise.resolve()
  })
}

/** Frequencies (Hz) each cue schedules, in oscillator order. */
function scheduledFreqs(ctx: FakeAudioContext): number[] {
  return ctx.oscillators.map((osc) => osc.frequency.setValueAtTime.mock.calls[0]?.[0] as number)
}

/** The one context a play call should have created. */
function soleContext(): FakeAudioContext {
  const ctx = FakeAudioContext.instances[0]
  if (ctx === undefined) throw new Error('playSettleSound created no AudioContext')
  return ctx
}

describe('playSettleSound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    FakeAudioContext.instances = []
    FakeAudioContext.ctorError = null
    FakeAudioContext.resumeError = null
    FakeAudioContext.resumeThrows = false
    FakeAudioContext.closeError = null
    FakeAudioContext.scheduleError = null
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('webkitAudioContext', undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    [
      'complete',
      [
        [523.25, 0, 0.32],
        [659.25, 0.085, 0.36],
      ],
      0.915774,
    ],
    [
      'attention',
      [
        [659.25, 0, 0.22],
        [659.25, 0.19, 0.22],
        [783.99, 0.32, 0.28],
      ],
      1.000393,
    ],
    [
      'error',
      [
        [440, 0, 0.26],
        [349.23, 0.11, 0.3],
      ],
      0.98955,
    ],
  ] as const)('plays the auditioned Soft Glass %s cue and envelopes', (kind, notes, level) => {
    playSettleSound(kind)
    const ctx = soleContext()
    expect(ctx.oscillators).toHaveLength(notes.length * 3)
    expect(ctx.gains).toHaveLength(1 + notes.length * 4)
    expect(ctx.gains[0]?.gain.value).toBe(level)
    expect(ctx.gains[0]?.connect).toHaveBeenCalledWith(ctx.destination)
    const partials = [
      [1, 1, 1],
      [2, 0.14, 0.45],
      [2.76, 0.09, 0.3],
    ] as const
    expect(scheduledFreqs(ctx)).toEqual(
      notes.flatMap(([freq]) => partials.map(([ratio]) => freq * ratio)),
    )
    notes.forEach(([, delay, duration], noteIndex) => {
      const start = 100.02 + delay
      const release = ctx.gains[1 + noteIndex * 4]
      expect(release?.connect).toHaveBeenCalledWith(ctx.gains[0])
      expect(release?.gain.setValueAtTime.mock.calls).toEqual([
        [1, start],
        [1, start + duration],
      ])
      expect(release?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, start + duration + 0.02)
      partials.forEach(([, amount, decay], partialIndex) => {
        const osc = ctx.oscillators[noteIndex * 3 + partialIndex]
        const gain = ctx.gains[2 + noteIndex * 4 + partialIndex]
        expect(osc?.type).toBe('sine')
        expect(osc?.frequency.value).toBe(
          osc?.frequency.setValueAtTime.mock.calls[0]?.[0] as number,
        )
        expect(osc?.connect).toHaveBeenCalledWith(gain)
        expect(gain?.connect).toHaveBeenCalledWith(release)
        expect(gain?.gain.setValueAtTime).toHaveBeenCalledWith(0, start)
        expect(gain?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
          0.14 * amount,
          start + 0.012,
        )
        expect(gain?.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
          0.0001 * amount,
          start + duration * decay,
        )
        expect(osc?.start).toHaveBeenCalledWith(start)
        expect(osc?.stop).toHaveBeenCalledWith(start + duration + 0.02)
        expect(start + duration + 0.02).toBeLessThan(100.9)
      })
    })
    vi.advanceTimersByTime(899)
    expect(ctx.closed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(ctx.close).toHaveBeenCalledTimes(1)
  })

  it('resumes the context so a suspended start still sounds', () => {
    playSettleSound('complete')
    expect(soleContext().resume).toHaveBeenCalledTimes(1)
  })

  it('uses the vendor AudioContext fallback', () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', FakeAudioContext)
    playSettleSound('complete')
    expect(soleContext().oscillators).toHaveLength(6)
  })

  it('logs a missing AudioContext without throwing', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(() => playSettleSound('complete')).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(logs.warn).toHaveBeenCalledWith('settle sound skipped: no AudioContext available')
  })

  it('logs a constructor failure without throwing', () => {
    const error = new Error('audio device gone')
    FakeAudioContext.ctorError = error
    expect(() => playSettleSound('error')).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(logs.warn).toHaveBeenCalledWith(
      'settle sound skipped: AudioContext construction failed',
      { error },
    )
  })

  it('logs a synchronous resume failure and still tears down the context', () => {
    FakeAudioContext.resumeThrows = true
    expect(() => playSettleSound('attention')).not.toThrow()
    expect(logs.warn).toHaveBeenCalledWith('settle sound resume failed', {
      error: new Error('resume failed'),
    })
    vi.advanceTimersByTime(900)
    expect(soleContext().closed).toBe(true)
  })

  it('logs a rejected resume and still tears down the context', async () => {
    const error = new Error('resume rejected')
    FakeAudioContext.resumeError = error
    playSettleSound('complete')
    await vi.advanceTimersByTimeAsync(900)
    expect(logs.warn).toHaveBeenCalledWith('settle sound resume failed', { error })
    expect(soleContext().closed).toBe(true)
  })

  it('closes immediately if scheduling fails after a partial has started', () => {
    const error = new Error('oscillator failed')
    FakeAudioContext.scheduleError = error
    expect(() => playSettleSound('complete')).not.toThrow()
    expect(soleContext().oscillators).toHaveLength(1)
    expect(soleContext().oscillators[0]?.start).toHaveBeenCalledTimes(1)
    expect(soleContext().close).toHaveBeenCalledTimes(1)
    expect(logs.warn).toHaveBeenCalledWith('settle sound scheduling failed', { error })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a rejected close without an unhandled rejection', async () => {
    const error = new Error('close rejected')
    FakeAudioContext.closeError = error
    playSettleSound('error')
    await vi.advanceTimersByTimeAsync(900)
    expect(logs.warn).toHaveBeenCalledWith('settle sound close failed', { error })
  })

  it('tears down every context after repeated notifications', () => {
    playSettleSound('complete')
    playSettleSound('error')
    playSettleSound('attention')
    expect(FakeAudioContext.instances).toHaveLength(3)
    vi.advanceTimersByTime(900)
    expect(FakeAudioContext.instances.every((ctx) => ctx.closed)).toBe(true)
  })
})

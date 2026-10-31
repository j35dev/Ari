import { createLogger } from '@ari/shared/logger'

/**
 * The Soft Glass turn-settle cues: a rounded mallet lift on completion, a
 * repeated cue for approval / questions, and a lower falling third on failure.
 * A sine fundamental and two faster-decaying glass partials are synthesized
 * with Web Audio, so there is no audio asset to ship or decode.
 *
 * Chromium blocks this without a user gesture; the main process opts the app
 * out with `--autoplay-policy=no-user-gesture-required` (see src/main/index.ts).
 * That switch is not a guarantee — a fresh context can still start
 * `suspended` — so every play resumes before scheduling. Failures are logged
 * and skipped — settling must never break over audio.
 */

const log = createLogger('moment:settle-sound')

/** How long the longest cue needs before the context can be torn down. */
const TEARDOWN_MS = 900

export type SettleSoundKind = 'complete' | 'error' | 'attention'

const ATTACK = 0.012
const RELEASE = 0.02
const TONE_GAIN = 0.14
const PARTIALS = [
  [1, 1, 1],
  [2, 0.14, 0.45],
  [2.76, 0.09, 0.3],
] as const

// Offline-calibrated to the approved previews' 0.045 active RMS, without
// synthesizing or normalizing PCM on the renderer's notification path.
const CUES = {
  complete: {
    level: 0.915774,
    notes: [
      [523.25, 0, 0.32],
      [659.25, 0.085, 0.36],
    ],
  },
  attention: {
    level: 1.000393,
    notes: [
      [659.25, 0, 0.22],
      [659.25, 0.19, 0.22],
      [783.99, 0.32, 0.28],
    ],
  },
  error: {
    level: 0.98955,
    notes: [
      [440, 0, 0.26],
      [349.23, 0.11, 0.3],
    ],
  },
} as const

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

function tone(
  ctx: AudioContext,
  output: GainNode,
  start: number,
  duration: number,
  freq: number,
): void {
  const release = ctx.createGain()
  release.gain.setValueAtTime(1, start)
  release.gain.setValueAtTime(1, start + duration)
  release.gain.linearRampToValueAtTime(0, start + duration + RELEASE)
  release.connect(output)

  for (const [ratio, amount, decay] of PARTIALS) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    // A mid-quantum start otherwise inherits a phase offset from the default
    // 440 Hz; seed the intrinsic frequency to match the auditioned waveform.
    osc.frequency.value = freq * ratio
    osc.frequency.setValueAtTime(freq * ratio, start)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(TONE_GAIN * amount, start + ATTACK)
    gain.gain.exponentialRampToValueAtTime(0.0001 * amount, start + duration * decay)
    osc.connect(gain).connect(release)
    osc.start(start)
    osc.stop(start + duration + RELEASE)
  }
}

/**
 * Plays the selected Soft Glass cue: completion C5→E5, attention E5/E5→G5,
 * or error A4→F4. The restrained upper partials decay before the fundamental.
 */
export function playSettleSound(kind: SettleSoundKind): void {
  const Ctor = audioContextCtor()
  if (!Ctor) {
    log.warn('settle sound skipped: no AudioContext available')
    return
  }

  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch (error: unknown) {
    log.warn('settle sound skipped: AudioContext construction failed', { error })
    return
  }

  const close = (): void => {
    void ctx.close().catch((error: unknown) => {
      log.warn('settle sound close failed', { error })
    })
  }

  // A fresh context may start suspended even with the autoplay-policy opt-out;
  // without this the scheduled tones never advance and the cue is silent.
  try {
    const resumed: unknown = ctx.resume?.()
    if (resumed instanceof Promise) {
      void resumed.catch((error: unknown) => {
        log.warn('settle sound resume failed', { error })
      })
    }
  } catch (error: unknown) {
    log.warn('settle sound resume failed', { error })
  }

  try {
    const cue = CUES[kind]
    const output = ctx.createGain()
    output.gain.value = cue.level
    output.connect(ctx.destination)
    const now = ctx.currentTime + 0.02
    for (const [freq, delay, duration] of cue.notes) {
      tone(ctx, output, now + delay, duration, freq)
    }
  } catch (error: unknown) {
    log.warn('settle sound scheduling failed', { error })
    close()
    return
  }

  setTimeout(close, TEARDOWN_MS)
}

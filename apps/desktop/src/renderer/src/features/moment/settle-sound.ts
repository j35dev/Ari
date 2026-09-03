import { createLogger } from '@ari/shared/logger'

/**
 * The turn-settle cue: a soft two-note lift when a turn completes, a
 * muted falling third when it fails, and a bright ping-pair when the agent
 * stalls waiting on the user (approval / question). Synthesized with Web
 * Audio like the launch signature (`awaken-sound.ts`) so there is no audio
 * asset to ship.
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

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** One plucked sine with a fast attack and exponential tail. */
function tone(
  ctx: AudioContext,
  start: number,
  duration: number,
  freq: number,
  gain: number,
): void {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, start)
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.014)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(g).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/**
 * Plays the settle cue once. A completion is a rising fifth (D5→A5); an error
 * is a quieter falling minor third (G4→E♭4) so failures are heard as a step
 * down without sounding like an alarm; attention is a higher fifth (G5→D6)
 * so a blocked turn sounds distinct from a finished one.
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
    void ctx.close().catch(() => undefined)
  }

  // A fresh context may start suspended even with the autoplay-policy opt-out;
  // without this the scheduled tones never advance and the cue is silent.
  try {
    const resumed: unknown = ctx.resume?.()
    if (resumed instanceof Promise) void resumed.catch(() => undefined)
  } catch (error: unknown) {
    log.warn('settle sound resume failed', { error })
  }

  try {
    const now = ctx.currentTime + 0.02
    if (kind === 'error') {
      tone(ctx, now, 0.34, 392.0, 0.13) // G4
      tone(ctx, now + 0.13, 0.42, 311.13, 0.12) // E♭4
    } else if (kind === 'attention') {
      tone(ctx, now, 0.28, 783.99, 0.15) // G5
      tone(ctx, now + 0.09, 0.36, 1174.66, 0.14) // D6
    } else {
      tone(ctx, now, 0.3, 587.33, 0.16) // D5
      tone(ctx, now + 0.1, 0.4, 880.0, 0.14) // A5
    }
  } catch (error: unknown) {
    log.warn('settle sound scheduling failed', { error })
    close()
    return
  }

  setTimeout(close, TEARDOWN_MS)
}

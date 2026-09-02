/**
 * The turn-settle cue: a soft two-note lift when a turn completes and a
 * muted falling third when it fails. Synthesized with Web Audio like the
 * launch signature (`awaken-sound.ts`) so there is no audio asset to ship.
 *
 * Chromium blocks this without a user gesture; the main process opts the app
 * out with `--autoplay-policy=no-user-gesture-required` (see src/main/index.ts).
 * Every failure path is swallowed — settling must never break over audio.
 */

/** How long the longest cue needs before the context can be torn down. */
const TEARDOWN_MS = 900

export type SettleSoundKind = 'complete' | 'error'

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
 * down without sounding like an alarm.
 */
export function playSettleSound(kind: SettleSoundKind): void {
  const Ctor = audioContextCtor()
  if (!Ctor) return

  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch {
    return
  }

  const close = (): void => {
    void ctx.close().catch(() => undefined)
  }

  try {
    const now = ctx.currentTime + 0.02
    if (kind === 'error') {
      tone(ctx, now, 0.34, 392.0, 0.035) // G4
      tone(ctx, now + 0.13, 0.42, 311.13, 0.032) // E♭4
    } else {
      tone(ctx, now, 0.3, 587.33, 0.05) // D5
      tone(ctx, now + 0.1, 0.4, 880.0, 0.045) // A5
    }
  } catch {
    close()
    return
  }

  setTimeout(close, TEARDOWN_MS)
}

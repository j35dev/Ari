import { createLogger } from '@ari/shared/logger'

/**
 * The launch impact: one clean cinematic hit (low body drop, upper knock,
 * and a short soft transient) fired on the reveal beat. Synthesized with Web
 * Audio so there is no audio asset to ship or decode — no beeps, typing, or
 * retro blips.
 *
 * Chromium blocks this without a user gesture; the main process opts the app
 * out with `--autoplay-policy=no-user-gesture-required` (see src/main/index.ts).
 * That switch is not a guarantee — a fresh context can still start
 * `suspended` — so playback resumes before scheduling. Failures are logged:
 * a launch must never break over audio.
 */

const log = createLogger('moment:awaken-sound')

/** How long the sequence needs before the context can be torn down. */
const TEARDOWN_MS = 1_200

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/**
 * Plays the impact once. Returns a disposer that tears the audio context
 * down early (used when the splash unmounts before the sound finishes).
 */
export function playAwakenSound(): () => void {
  const Ctor = audioContextCtor()
  if (!Ctor) {
    log.warn('awaken sound skipped: no AudioContext available')
    return () => undefined
  }

  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch (error: unknown) {
    log.warn('awaken sound skipped: AudioContext construction failed', { error })
    return () => undefined
  }

  const close = (): void => {
    void ctx.close().catch(() => undefined)
  }

  // Without this the sequence stays silent when the fresh context starts
  // suspended (cold boot, before any user gesture).
  try {
    const resumed: unknown = ctx.resume?.()
    if (resumed instanceof Promise) void resumed.catch(() => undefined)
  } catch (error: unknown) {
    log.warn('awaken sound resume failed', { error })
  }

  try {
    const now = ctx.currentTime + 0.02

    // Low body: sine dropping 92Hz to 58Hz.
    const low = ctx.createOscillator()
    const lowGain = ctx.createGain()
    low.type = 'sine'
    low.frequency.setValueAtTime(92, now)
    low.frequency.exponentialRampToValueAtTime(58, now + 0.34)
    lowGain.gain.setValueAtTime(0.0001, now)
    lowGain.gain.exponentialRampToValueAtTime(0.13, now + 0.012)
    lowGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52)
    low.connect(lowGain).connect(ctx.destination)
    low.start(now)
    low.stop(now + 0.56)

    // Upper knock: sine dropping 430Hz to 300Hz.
    const hi = ctx.createOscillator()
    const hiGain = ctx.createGain()
    hi.type = 'sine'
    hi.frequency.setValueAtTime(430, now)
    hi.frequency.exponentialRampToValueAtTime(300, now + 0.18)
    hiGain.gain.setValueAtTime(0.0001, now)
    hiGain.gain.exponentialRampToValueAtTime(0.035, now + 0.008)
    hiGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26)
    hi.connect(hiGain).connect(ctx.destination)
    hi.start(now)
    hi.stop(now + 0.28)

    // Soft transient for the "hit": 35ms of lowpassed noise.
    const len = Math.floor(ctx.sampleRate * 0.035)
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    }
    const src = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const noiseGain = ctx.createGain()
    filter.type = 'lowpass'
    filter.frequency.value = 1000
    noiseGain.gain.value = 0.025
    src.buffer = buffer
    src.connect(filter).connect(noiseGain).connect(ctx.destination)
    src.start(now)
  } catch (error: unknown) {
    log.warn('awaken sound scheduling failed', { error })
    close()
    return () => undefined
  }

  const teardown = setTimeout(close, TEARDOWN_MS)
  return () => {
    clearTimeout(teardown)
    close()
  }
}

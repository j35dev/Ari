import { createLogger } from '@ari/shared/logger'

/**
 * The launch signature sound: a quiet filtered breath, a three-note C–E–G
 * lift, and a high shimmer on the final logo beat. Synthesized with Web Audio
 * so there is no audio asset to ship or decode.
 *
 * Chromium blocks this without a user gesture; the main process opts the app
 * out with `--autoplay-policy=no-user-gesture-required` (see src/main/index.ts).
 * That switch is not a guarantee — a fresh context can still start
 * `suspended` — so playback resumes before scheduling. Failures are logged:
 * a launch must never break over audio.
 */

const log = createLogger('moment:awaken-sound')

/** How long the sequence needs before the context can be torn down. */
const TEARDOWN_MS = 2_400

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
  g.gain.linearRampToValueAtTime(gain, start + 0.018)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(g).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

/**
 * Plays the signature once. Returns a disposer that tears the audio context
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

    // Breath: filtered noise with a decaying envelope.
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1800
    filter.Q.value = 0.4

    const noise = ctx.createBufferSource()
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.42), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.7) * 0.2
    }
    noise.buffer = buffer

    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(0.0001, now)
    noiseGain.gain.linearRampToValueAtTime(0.12, now + 0.16)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
    noise.connect(filter).connect(noiseGain).connect(ctx.destination)
    noise.start(now)

    tone(ctx, now + 0.55, 0.65, 261.63, 0.09) // C
    tone(ctx, now + 0.67, 0.72, 329.63, 0.095) // E
    tone(ctx, now + 0.8, 0.92, 392.0, 0.085) // G

    const shimmer = ctx.createOscillator()
    const shimmerGain = ctx.createGain()
    shimmer.type = 'sine'
    shimmer.frequency.setValueAtTime(880, now + 1.28)
    shimmer.frequency.exponentialRampToValueAtTime(1320, now + 1.72)
    shimmerGain.gain.setValueAtTime(0.0001, now + 1.28)
    shimmerGain.gain.linearRampToValueAtTime(0.07, now + 1.38)
    shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.82)
    shimmer.connect(shimmerGain).connect(ctx.destination)
    shimmer.start(now + 1.28)
    shimmer.stop(now + 1.84)
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

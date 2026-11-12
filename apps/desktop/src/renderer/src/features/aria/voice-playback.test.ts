import { expect, it, vi } from 'vitest'
import { VoicePlayback } from './voice-playback'

it('stops immediately and drops audio decoded after a newer generation', async () => {
  let decode!: (value: AudioBuffer) => void
  const source = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }
  const context = { decodeAudioData: vi.fn(() => new Promise<AudioBuffer>(resolve => { decode = resolve })), resume: vi.fn(async () => undefined), createBufferSource: vi.fn(() => source), close: vi.fn() }
  const played = vi.fn(); const player = new VoicePlayback(played, () => context as unknown as AudioContext)
  const old = player.observe({ generation: 1, id: 1, audio: new Uint8Array([1]) })
  await player.observe({ generation: 2, stop: true })
  decode({} as AudioBuffer); await old
  expect(source.start).not.toHaveBeenCalled(); expect(played).not.toHaveBeenCalled()
})
it('stops an active source when new speech replaces it', async () => {
  const source = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null }
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const context = { decodeAudioData: vi.fn(async () => ({})), resume: vi.fn(async () => undefined), createBufferSource: vi.fn(() => source), createGain: vi.fn(() => gain), close: vi.fn() }
  const player = new VoicePlayback(vi.fn(), () => context as unknown as AudioContext)
  await player.observe({ generation: 1, id: 1, audio: new Uint8Array([1]) })
  expect(source.start).toHaveBeenCalledTimes(1)
  await player.observe({ generation: 2, stop: true })
  expect(source.stop).toHaveBeenCalledTimes(1)
})

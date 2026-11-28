import { expect, it, vi } from 'vitest'
import { VoicePlayback } from './voice-playback'

it('stops immediately and drops audio decoded after a newer generation', async () => {
  let decode!: (value: AudioBuffer) => void
  const source = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }
  const context = {
    decodeAudioData: vi.fn(
      () =>
        new Promise<AudioBuffer>((resolve) => {
          decode = resolve
        }),
    ),
    resume: vi.fn(async () => undefined),
    createBufferSource: vi.fn(() => source),
    close: vi.fn(),
  }
  const played = vi.fn()
  const player = new VoicePlayback(played, () => context as unknown as AudioContext)
  const old = player.observe({ generation: 1, id: 1, audio: new Uint8Array([1]) })
  await Promise.resolve()
  await player.observe({ generation: 2, stop: true })
  decode({} as AudioBuffer)
  await old
  expect(source.start).not.toHaveBeenCalled()
  expect(played).not.toHaveBeenCalled()
})
it('stops an active source when new speech replaces it', async () => {
  const source = {
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    onended: null,
  }
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    currentTime: 0,
    decodeAudioData: vi.fn(async () => ({ duration: 1 })),
    resume: vi.fn(async () => undefined),
    createBufferSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    close: vi.fn(),
  }
  const player = new VoicePlayback(vi.fn(), () => context as unknown as AudioContext)
  await player.observe({ generation: 1, id: 1, audio: new Uint8Array([1]) })
  expect(source.start).toHaveBeenCalledTimes(1)
  await player.observe({ generation: 2, stop: true })
  expect(source.stop).toHaveBeenCalledTimes(1)
})
it('drops a pending decode immediately when Esc stops playback locally', async () => {
  let decode!: (value: AudioBuffer) => void
  const context = {
    decodeAudioData: vi.fn(
      () =>
        new Promise<AudioBuffer>((resolve) => {
          decode = resolve
        }),
    ),
    resume: vi.fn(async () => undefined),
    createBufferSource: vi.fn(),
  }
  const player = new VoicePlayback(vi.fn(), () => context as unknown as AudioContext)
  const pending = player.observe({ generation: 1, id: 1, audio: new Uint8Array([1]) })
  await Promise.resolve()
  player.stop()
  decode({} as AudioBuffer)
  await pending
  expect(context.createBufferSource).not.toHaveBeenCalled()
})

it('schedules ready audio at the previous end and stops both playing and scheduled clips', async () => {
  const sources = Array.from({ length: 3 }, () => ({
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    onended: () => {},
  }))
  const context = {
    currentTime: 10,
    state: 'running',
    decodeAudioData: vi.fn(async () => ({ duration: 1 })),
    createBufferSource: vi
      .fn(() => sources[0])
      .mockReturnValueOnce(sources[0])
      .mockReturnValueOnce(sources[1])
      .mockReturnValueOnce(sources[2]),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
  }
  const played = vi.fn()
  const player = new VoicePlayback(played, () => context as unknown as AudioContext)
  const audio = new Uint8Array([1])
  await player.observe({ generation: 1, id: 1, audio })
  context.currentTime = 10.25
  await player.observe({ generation: 1, id: 2, audio })
  expect(sources[0]!.start).toHaveBeenCalledWith(10)
  expect(sources[1]!.start).toHaveBeenCalledWith(11)
  expect(played).not.toHaveBeenCalled()
  context.currentTime = 11
  sources[0]!.onended()
  expect(played).toHaveBeenCalledExactlyOnceWith(1, 1)

  await player.observe({ generation: 1, id: 3, audio })
  expect(sources[2]!.start).toHaveBeenCalledWith(12)
  player.stop()
  expect(sources[0]!.stop).not.toHaveBeenCalled()
  expect(sources[1]!.stop).toHaveBeenCalledOnce()
  expect(sources[2]!.stop).toHaveBeenCalledOnce()
  sources[1]!.onended()
  sources[2]!.onended()
  expect(played).toHaveBeenCalledTimes(1)
})

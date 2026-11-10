import { afterEach, describe, expect, it, vi } from 'vitest'
import { resampleMono, startRecording } from './recorder'

afterEach(() => vi.unstubAllGlobals())

function microphone() {
  const stopTrack = vi.fn()
  const trackEvents = new Map<string, () => void>()
  const processorEvents = new Map<string, () => void>()
  const track = {
    stop: stopTrack,
    addEventListener: (event: string, callback: () => void) => trackEvents.set(event, callback),
    removeEventListener: (event: string) => trackEvents.delete(event),
  }
  const close = vi.fn(async () => undefined)
  const disconnect = vi.fn()
  const addModule = vi.fn(async () => undefined)
  const port = { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null }
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 16_000
      state = 'running'
      audioWorklet = { addModule }
      destination = {}
      close = close
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect })
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn() })
    },
  )
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = port
      connect = vi.fn()
      disconnect = vi.fn()
      addEventListener = (event: string, callback: () => void) =>
        processorEvents.set(event, callback)
    },
  )
  return {
    stopTrack,
    stop: stopTrack,
    trackEvents,
    processorEvents,
    close,
    disconnect,
    addModule,
    getUserMedia,
    emit: (data: Float32Array) => port.onmessage?.({ data } as MessageEvent<Float32Array>),
  }
}

it('captures audio beyond five minutes until explicit stop, including the final words', async () => {
  const mic = microphone()
  const recording = await startRecording()
  const second = new Float32Array(16_000).fill(0.25)
  for (let i = 0; i < 360; i++) mic.emit(second)
  mic.emit(new Float32Array([0.75, -0.75]))
  expect(mic.stopTrack).not.toHaveBeenCalled()
  expect(mic.close).not.toHaveBeenCalled()
  expect(recording.level()).toBeGreaterThan(0)
  const stopped = recording.stop()
  expect(recording.stop()).toBe(stopped)
  const pcm = await stopped
  expect(pcm).toHaveLength(16_000 * 360 + 2)
  expect(pcm[0]).toBe(0.25)
  expect(pcm.slice(-2)).toEqual(new Float32Array([0.75, -0.75]))
  expect(mic.stopTrack).toHaveBeenCalledOnce()
  expect(mic.close).toHaveBeenCalledOnce()
  expect(recording.level()).toBe(0)
})

it('keeps a long capture ready until stop and balances ducking callbacks exactly once', async () => {
  const mic = microphone()
  const onReady = vi.fn()
  const onStopped = vi.fn()
  const recording = await startRecording({ onReady, onStopped })
  const second = new Float32Array(16_000).fill(0.25)
  for (let i = 0; i < 360; i++) mic.emit(second)
  expect(onReady).toHaveBeenCalledOnce()
  expect(onStopped).not.toHaveBeenCalled()
  expect(mic.stopTrack).not.toHaveBeenCalled()
  expect(await recording.stop()).toHaveLength(16_000 * 360)
  recording.cancel()
  expect(onStopped).toHaveBeenCalledOnce()
  expect(mic.close).toHaveBeenCalledOnce()
})

it('discards captured audio and releases the microphone on explicit cancellation', async () => {
  const mic = microphone()
  const recording = await startRecording()
  mic.emit(new Float32Array([0.25]))
  recording.cancel()
  mic.emit(new Float32Array([0.75]))
  expect(await recording.stop()).toHaveLength(0)
  expect(mic.stopTrack).toHaveBeenCalledOnce()
  expect(mic.close).toHaveBeenCalledOnce()
})

it('cleans up the microphone and reports a genuine audio setup failure', async () => {
  const mic = microphone()
  mic.addModule.mockRejectedValueOnce(new Error('Audio worklet failed'))
  await expect(startRecording()).rejects.toThrow('Audio worklet failed')
  expect(mic.stopTrack).toHaveBeenCalledOnce()
  expect(mic.close).toHaveBeenCalledOnce()
})

describe('16 kHz mono resampling', () => {
  it('preserves duration and averages 48 kHz sample intervals', () => {
    const pcm = resampleMono(Float32Array.from([0, 0.3, 0.6, -0.3, -0.6, -0.9]), 48_000)
    expect(pcm).toHaveLength(2)
    expect(pcm[0]).toBeCloseTo(0.3)
    expect(pcm[1]).toBeCloseTo(-0.6)
  })
  it('handles fractional 44.1 kHz intervals and retains constant amplitude', () => {
    const pcm = resampleMono(new Float32Array(44_100).fill(0.25), 44_100)
    expect(pcm).toHaveLength(16_000)
    expect(pcm.every((value) => Math.abs(value - 0.25) < 0.00001)).toBe(true)
  })
  it('copies existing 16 kHz PCM and rejects invalid rates', () => {
    const input = new Float32Array([0.2, -0.2])
    expect(resampleMono(input, 16_000)).toEqual(input)
    expect(resampleMono(input, 16_000)).not.toBe(input)
    expect(() => resampleMono(input, 0)).toThrow('sample rate')
  })
})

it('signals readiness on first samples and stops exactly once on cancellation', async () => {
  const mic = microphone()
  const onReady = vi.fn()
  const onStopped = vi.fn()
  const recording = await startRecording({ onReady, onStopped })
  expect(onReady).not.toHaveBeenCalled()
  mic.emit(new Float32Array([0.2]))
  mic.emit(new Float32Array([0.3]))
  expect(onReady).toHaveBeenCalledOnce()
  recording.cancel()
  recording.cancel()
  expect(await recording.stop()).toHaveLength(0)
  expect(onStopped).toHaveBeenCalledOnce()
  expect(mic.stop).toHaveBeenCalledOnce()
})

it.each(['track', 'processor'])('stops and reports an unexpected %s failure', async (source) => {
  const mic = microphone()
  const onStopped = vi.fn()
  const onError = vi.fn()
  const recording = await startRecording({ onStopped, onError })
  mic.emit(new Float32Array([0.2]))
  if (source === 'track') mic.trackEvents.get('ended')!()
  else mic.processorEvents.get('processorerror')!()
  expect(onStopped).toHaveBeenCalledOnce()
  expect(onError).toHaveBeenCalledWith(expect.any(Error))
  await expect(recording.stop()).rejects.toThrow('stopped unexpectedly')
})

it('reports cleanup without readiness when microphone setup fails', async () => {
  const mic = microphone()
  const onReady = vi.fn()
  const onStopped = vi.fn()
  mic.addModule.mockRejectedValueOnce(new Error('Worklet unavailable'))
  await expect(startRecording({ onReady, onStopped })).rejects.toThrow('Worklet unavailable')
  expect(onReady).not.toHaveBeenCalled()
  expect(onStopped).toHaveBeenCalledOnce()
})

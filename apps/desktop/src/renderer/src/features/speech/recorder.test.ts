import { afterEach, describe, expect, it, vi } from 'vitest'
import { resampleMono, startRecording } from './recorder'

afterEach(() => vi.unstubAllGlobals())

function microphone() {
  const trackEvents = new Map<string, () => void>()
  const stop = vi.fn()
  const track = {
    stop,
    addEventListener: (event: string, callback: () => void) => trackEvents.set(event, callback),
    removeEventListener: (event: string) => trackEvents.delete(event),
  }
  const port = { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null }
  const processorEvents = new Map<string, () => void>()
  const addModule = vi.fn(async () => undefined)
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  })
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 16_000
      state = 'running'
      audioWorklet = { addModule }
      close = vi.fn(async () => undefined)
      destination = {}
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
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
    stop,
    trackEvents,
    processorEvents,
    addModule,
    emit: (data: Float32Array) => port.onmessage?.({ data } as MessageEvent<Float32Array>),
  }
}

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

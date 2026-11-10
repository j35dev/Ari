// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { RecordingFlow, hasSpeech, type Recording, type RecordingDeps } from './flow'
import type { WidgetState } from '../../main/aria-widget/model'
import type { RecordingEvents } from '../src/features/speech/recorder'

const state = (id: number, phase: WidgetState['phase']): WidgetState => ({
  id,
  phase,
  text: '',
  setup: false,
})
const pcm = new Float32Array(1600).fill(0.02)
function fake(): RecordingDeps & { recording: Recording } {
  const recording = { stop: vi.fn(async () => pcm), cancel: vi.fn(), level: () => 0.1 }
  return {
    recording,
    record: vi.fn(async () => recording),
    invoke: vi.fn(async (method) => {
      if (method === 'speech.status') return { ready: true }
      if (method === 'speech.transcribe') return { text: 'Fix the build' }
      return undefined
    }),
  }
}

it('records while held and transcribes once on release', async () => {
  const deps = fake()
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  expect(deps.record).toHaveBeenCalledOnce()
  expect(deps.invoke).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(flow.level()).toBe(0.1))
  flow.observe(state(1, 'transcribing'))
  flow.observe(state(1, 'transcribing'))
  await vi.waitFor(() =>
    expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.complete', {
      id: 1,
      text: 'Fix the build',
    }),
  )
  expect(deps.recording.stop).toHaveBeenCalledOnce()
  expect(deps.invoke).toHaveBeenCalledWith('speech.transcribe', { pcm })
  flow.dispose()
})

it('waits for microphone acquisition after a quick release', async () => {
  const deps = fake()
  let resolve!: (recording: Recording) => void
  deps.record = () =>
    new Promise((done) => {
      resolve = done
    })
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  flow.observe(state(1, 'transcribing'))
  resolve(deps.recording)
  await vi.waitFor(() => expect(deps.recording.stop).toHaveBeenCalledOnce())
  await vi.waitFor(() =>
    expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.complete', {
      id: 1,
      text: 'Fix the build',
    }),
  )
  flow.dispose()
})

it('cancels a microphone that finishes opening after Escape', async () => {
  const deps = fake()
  let resolve!: (recording: Recording) => void
  deps.record = () =>
    new Promise((done) => {
      resolve = done
    })
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  flow.observe(state(1, 'hidden'))
  resolve(deps.recording)
  await vi.waitFor(() => expect(deps.recording.cancel).toHaveBeenCalled())
  expect(deps.invoke).not.toHaveBeenCalledWith('speech.transcribe', expect.anything())
  flow.dispose()
})

it('ignores transcription that finishes after cancellation or a newer hold', async () => {
  const deps = fake()
  let resolve!: (result: { text: string }) => void
  deps.invoke = vi.fn(async (method) =>
    method === 'speech.status'
      ? { ready: true }
      : method === 'speech.transcribe'
        ? new Promise((done) => {
            resolve = done
          })
        : undefined,
  )
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  flow.observe(state(1, 'transcribing'))
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  flow.observe(state(1, 'hidden'))
  flow.observe(state(2, 'listening'))
  resolve({ text: 'Old speech' })
  await vi.waitFor(() => expect(deps.record).toHaveBeenCalledTimes(2))
  expect(deps.invoke).not.toHaveBeenCalledWith('ariaWidget.complete', expect.anything())
  flow.dispose()
})

it('hides silence without calling the transcription service', async () => {
  const deps = fake()
  deps.recording.stop = async () => new Float32Array(1600)
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  flow.observe(state(1, 'transcribing'))
  await vi.waitFor(() =>
    expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.complete', { id: 1, text: '' }),
  )
  expect(deps.invoke).not.toHaveBeenCalledWith('speech.transcribe', expect.anything())
  flow.dispose()
})

it('starts the microphone immediately and shows setup if transcription loses readiness', async () => {
  const deps = fake()
  deps.invoke = vi.fn(async (method) => {
    if (method === 'speech.transcribe') throw new Error('Speech is not configured')
    return { ready: false }
  })
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  expect(deps.record).toHaveBeenCalledOnce()
  expect(deps.invoke).not.toHaveBeenCalled()
  flow.observe(state(1, 'transcribing'))
  await vi.waitFor(() =>
    expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.error', {
      id: 1,
      text: 'Set up speech to text in Settings',
      setup: true,
    }),
  )
  expect(deps.invoke).toHaveBeenCalledWith('speech.transcribe', { pcm })
  flow.dispose()
})

it('distinguishes silence and very short taps from audible PCM', () => {
  expect(hasSpeech(new Float32Array(1600))).toBe(false)
  expect(hasSpeech(new Float32Array(10).fill(1))).toBe(false)
  expect(hasSpeech(pcm)).toBe(true)
})

it('publishes ducking readiness only for an actively listening capture and restores on recorder cleanup', async () => {
  const deps = fake()
  let events!: RecordingEvents
  deps.record = async (callbacks) => {
    events = callbacks!
    return deps.recording
  }
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  events.onReady?.()
  expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.capture', { id: 1, active: true })
  flow.observe(state(1, 'transcribing'))
  vi.mocked(deps.invoke).mockClear()
  events.onReady?.()
  expect(deps.invoke).not.toHaveBeenCalledWith('ariaWidget.capture', { id: 1, active: true })
  events.onStopped?.()
  expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.capture', { id: 1, active: false })
  flow.dispose()
})

it('ignores delayed microphone readiness after cancellation and reports active capture failure', async () => {
  const deps = fake()
  let events!: RecordingEvents
  deps.record = async (callbacks) => {
    events = callbacks!
    return deps.recording
  }
  const flow = new RecordingFlow(deps)
  flow.observe(state(1, 'listening'))
  flow.observe(state(1, 'hidden'))
  events.onReady?.()
  expect(deps.invoke).not.toHaveBeenCalledWith('ariaWidget.capture', { id: 1, active: true })
  flow.observe(state(2, 'listening'))
  events.onError?.(new Error('Microphone disconnected'))
  expect(deps.invoke).toHaveBeenCalledWith('ariaWidget.error', {
    id: 2,
    text: 'Microphone disconnected',
    setup: false,
  })
  flow.dispose()
})

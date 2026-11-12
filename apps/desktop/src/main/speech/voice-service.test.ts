// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SettingsStore } from '@ari/engine/settings'
import { defaultSettings } from '@ari/contracts/settings'
import type { SpeechService } from './service'
import type { GroqSpeech } from './groq'
const mock = vi.hoisted(() => ({ fork: vi.fn(), duck: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }))
vi.mock('./audio-ducking', () => ({ getAudioDucking: () => ({ setActive: mock.duck }) }))
import { VoiceService } from './voice-service'
const services: VoiceService[] = []
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose())
  vi.restoreAllMocks()
})

function fixture(cloud = false) {
  const child = new EventEmitter() as EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
  child.kill = vi.fn()
  child.postMessage = vi.fn((request) => {
    if (request.kind === 'cancel') return
    queueMicrotask(() =>
      child.emit(
        'message',
        request.kind === 'load'
          ? { id: request.id, hardware: { slow: false, rtf: 0.6, threads: 4 } }
          : { id: request.id, audio: { samples: new Float32Array(240), sampleRate: 24000 } },
      ),
    )
  })
  mock.fork.mockReturnValue(child)
  const contents = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
  const settings = {
    current: {
      ...defaultSettings,
      experimental: { ariaEnabled: true },
      ariaVoice: { ...defaultSettings.ariaVoice, engine: cloud ? 'groq' : 'kokoro' },
    },
  }
  const models = {
    models: vi.fn(async () => [{ id: 'kokoro-82m-v1.0', installed: { path: '/models/kokoro' } }]),
  }
  const groq = {
    speak: vi.fn(async (): Promise<Uint8Array> => {
      throw new Error('Groq has no API key. Using local speech.')
    }),
  }
  const service = new VoiceService(
    settings as SettingsStore,
    models as unknown as SpeechService,
    groq as unknown as GroqSpeech,
    contents as unknown as WebContents,
  )
  services.push(service)
  return { service, contents, settings, child, groq }
}
async function audioFrame(contents: { send: ReturnType<typeof vi.fn> }) {
  await vi.waitFor(() => expect(contents.send.mock.calls.some((call) => call[1]?.audio)).toBe(true))
  return contents.send.mock.calls.findLast((call) => call[1]?.audio)![1]
}
it('uses local audio and waits for playback acknowledgement without queueing another reply', async () => {
  const { service, contents } = fixture()
  const speaking = service.speak('The changes are ready.')
  const frame = await audioFrame(contents)
  service.played(frame.id, frame.generation)
  await speaking
  expect(mock.duck).toHaveBeenLastCalledWith(expect.any(String), false)
})
it('falls back from missing Groq credentials and publishes a clear message', async () => {
  const { service, contents, groq } = fixture(true)
  const notice = vi.fn()
  service.publish = notice
  const speaking = service.speak('The changes are ready.')
  const frame = await audioFrame(contents)
  service.played(frame.id, frame.generation)
  await speaking
  expect(groq.speak).toHaveBeenCalledOnce()
  expect(notice).toHaveBeenCalledWith(
    expect.objectContaining({ error: 'Groq has no API key. Using local speech.' }),
  )
})
it('interrupts playback immediately and ignores old acknowledgements', async () => {
  const { service, contents } = fixture()
  const old = service.speak('The changes are ready.')
  const frame = await audioFrame(contents)
  service.stop()
  service.played(frame.id, frame.generation)
  await old
  expect(contents.send).toHaveBeenLastCalledWith(
    'ari:ariaVoice.audio',
    expect.objectContaining({ stop: true, generation: frame.generation + 1 }),
  )
})
it('stops speech and unloads the worker when Aria is disabled', async () => {
  const { service, child, settings } = fixture()
  await service.warm()
  settings.current.experimental.ariaEnabled = false
  service.configure()
  expect(child.kill).toHaveBeenCalledOnce()
  expect((await service.status()).loaded).toBe(false)
})
it('keeps pronunciation-expanded Groq requests under its limit and streams without local fallback', async () => {
  const { service, contents, groq, child } = fixture(true)
  groq.speak.mockImplementation(async () => new Uint8Array([1]))
  contents.send.mockImplementation((_channel, frame) => {
    if (frame.audio) queueMicrotask(() => service.played(frame.id, frame.generation))
  })
  const line = 'Aria checked 1234567890 tests and 1234567890 files, and the PR and CLI are ready.'
  await service.speak(`<!-- aria:speak ${JSON.stringify({ text: line })} -->`)
  expect(groq.speak.mock.calls.length).toBeGreaterThan(1)
  for (const call of groq.speak.mock.calls as unknown as [string][])
    expect(call[0].length).toBeLessThanOrEqual(200)
  expect(child.postMessage.mock.calls.some(([request]) => request.kind === 'speak')).toBe(false)
})

it('Read aloud streams the written details, not only the authored automatic summary', async () => {
  const { service, contents, child } = fixture()
  contents.send.mockImplementation((_channel, frame) => {
    if (frame.audio) queueMicrotask(() => service.played(frame.id, frame.generation))
  })
  await service.speak(
    '<!-- aria:speak {"text":"The work is ready."} -->\nThe work is ready.\n- You can choose a project and an agent.\n- Workers report their results and questions.\n- Earlier sessions retain their context.\nWould you like to start?',
    { readAll: true },
  )
  const text = child.postMessage.mock.calls
    .filter(([request]) => request.kind === 'speak')
    .map(([request]) => request.text)
    .join(' ')
  expect(text).toContain('choose a project and an agent')
  expect(text).toContain('results and questions')
  expect(text).toContain('retain their context')
  expect(text).toContain('Would you like to start?')
})

it('clears an old playback error on retry and publishes completion after successful audio', async () => {
  const { service, contents, child } = fixture()
  const original = child.postMessage.getMockImplementation()! as (request: unknown) => void
  let fail = true
  child.postMessage.mockImplementation((request) => {
    if (request.kind === 'speak' && fail) {
      fail = false
      queueMicrotask(() =>
        child.emit('message', { id: request.id, error: 'Previous speech failed.' }),
      )
    } else original(request)
  })
  const publish = vi.fn()
  service.publish = publish
  await service.speak('The work is ready.')
  expect((await service.status()).error).toBe('Previous speech failed.')
  contents.send.mockImplementation((_channel, frame) => {
    if (frame.audio) queueMicrotask(() => service.played(frame.id, frame.generation))
  })
  await service.speak('The work is ready.')
  expect((await service.status()).error).toBeNull()
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'complete' }))
})

it('says a following passage after the one playing instead of cutting it off', async () => {
  const { service, contents } = fixture()
  const audioFrames = () => contents.send.mock.calls.filter((call) => call[1]?.audio)
  const first = service.speak('Finding the sessions.')
  const second = service.speak('Four sessions are gone.', { follow: true })
  const frame = await audioFrame(contents)
  // The second passage has not started: the first is still playing.
  expect(audioFrames()).toHaveLength(1)
  service.played(frame.id, frame.generation)
  await first
  await vi.waitFor(() => expect(audioFrames()).toHaveLength(2))
  const next = audioFrames()[1]![1]
  // Same generation: it followed, it did not interrupt.
  expect(next.generation).toBe(frame.generation)
  service.played(next.id, next.generation)
  await second
})
it('drops what was queued when speech is stopped', async () => {
  const { service, contents } = fixture()
  const first = service.speak('Finding the sessions.')
  const second = service.speak('Four sessions are gone.', { follow: true })
  await audioFrame(contents)
  service.stop()
  await Promise.all([first, second])
  expect(contents.send.mock.calls.filter((call) => call[1]?.audio)).toHaveLength(1)
})

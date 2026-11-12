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
    speak: vi.fn(async () => {
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

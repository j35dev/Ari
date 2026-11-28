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
    speak: vi.fn<GroqSpeech['speak']>(async () => {
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
it('synthesizes one complete opening sentence and waits for playback to finish', async () => {
  const { service, contents, child } = fixture()
  const text = 'The changes are ready for your review.'
  const speaking = service.speak(text)
  const frame = await audioFrame(contents)
  expect(child.postMessage.mock.calls.filter(([request]) => request.kind === 'speak')).toEqual([
    [expect.objectContaining({ text })],
  ])
  service.played(frame.id, frame.generation)
  await speaking
  expect(mock.duck).toHaveBeenLastCalledWith(expect.any(String), false)
})
it('falls back from missing Groq credentials and sends plain speech to Kokoro', async () => {
  const { service, contents, groq, child } = fixture(true)
  const notice = vi.fn()
  service.publish = notice
  const speaking = service.speak(
    '<!-- aria:speak {"text":"The changes are ready.","tone":"cheerful"} -->',
  )
  const frame = await audioFrame(contents)
  service.played(frame.id, frame.generation)
  await speaking
  expect(groq.speak).toHaveBeenCalledExactlyOnceWith(
    '[cheerful] The changes are ready.',
    expect.any(String),
    expect.any(AbortSignal),
  )
  expect(child.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'speak', text: 'The changes are ready.' }),
  )
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
it('fits expanded pronunciation within the Groq limit and directs only the opening', async () => {
  const { service, contents, groq, child } = fixture(true)
  groq.speak.mockImplementation(async () => new Uint8Array([1]))
  contents.send.mockImplementation((_channel, frame) => {
    if (frame.audio) queueMicrotask(() => service.played(frame.id, frame.generation))
  })
  const line =
    'Good news. Aria checked 1234567 tests and 2345678 files, and the PR lists 3456789 changes. Would you like me to open the results?'
  await service.speak(`<!-- aria:speak ${JSON.stringify({ text: line, tone: 'warm' })} -->`)
  const inputs = groq.speak.mock.calls.map(([text]) => text)
  expect(inputs.length).toBeGreaterThan(3)
  expect(inputs[0]).toBe('[warm] Good news.')
  expect(inputs[1]).toMatch(/^Ah ree uh/)
  expect(inputs.slice(1).every((input) => !input.includes('[warm]'))).toBe(true)
  expect(inputs.at(-1)).toBe('Would you like me to open the results?')
  expect(inputs.every((input) => input.length <= 200)).toBe(true)
  expect(child.postMessage.mock.calls.some(([request]) => request.kind === 'speak')).toBe(false)
})

it('keeps a sentence intact when it fits the Groq limit without the optional tone', async () => {
  const { service, contents, groq } = fixture(true)
  groq.speak.mockImplementation(async () => new Uint8Array([1]))
  contents.send.mockImplementation((_channel, frame) => {
    if (frame.audio) queueMicrotask(() => service.played(frame.id, frame.generation))
  })
  const text =
    "I checked the build and the update is ready for you to try, so you can open the desktop app to review the changes and send me your feedback when you've had a chance to see how it fits your work."
  await service.speak(`<!-- aria:speak ${JSON.stringify({ text, tone: 'warm' })} -->`)
  expect(groq.speak).toHaveBeenCalledExactlyOnceWith(
    text,
    expect.any(String),
    expect.any(AbortSignal),
  )
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

it('queues a following passage before playback ends and bounds outstanding audio', async () => {
  const { service, contents } = fixture()
  const audioFrames = () => contents.send.mock.calls.filter((call) => call[1]?.audio)
  const first = service.speak('Finding the sessions.')
  const second = service.speak('Four sessions are gone. Would you like the details?', {
    follow: true,
  })
  await vi.waitFor(() => expect(audioFrames()).toHaveLength(2))
  const frame = audioFrames()[0]![1]
  const next = audioFrames()[1]![1]
  expect(next.generation).toBe(frame.generation)
  service.played(frame.id, frame.generation)
  await first
  await vi.waitFor(() => expect(audioFrames()).toHaveLength(3))
  const last = audioFrames()[2]![1]
  service.played(next.id, next.generation)
  service.played(last.id, last.generation)
  await second
})
it('drops what was queued when speech is stopped', async () => {
  const { service, contents } = fixture()
  const first = service.speak('Finding the sessions.')
  const second = service.speak('Four sessions are gone. Would you like the details?', {
    follow: true,
  })
  const count = () => contents.send.mock.calls.filter((call) => call[1]?.audio).length
  await vi.waitFor(() => expect(count()).toBe(2))
  service.stop()
  await Promise.all([first, second])
  expect(count()).toBe(2)
})

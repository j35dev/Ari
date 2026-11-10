// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsStore } from '@ari/engine/settings'
import { SpeechService, speechRequestTimeout, speechWorkerExitError } from './service'
import * as engineModule from './engine'
import * as downloadModule from './download'
import type { SpeechProgress } from '@ari/contracts/rpc'
import { catalog } from './discovery'
import { ENGINE_HEADER_HASH, ENGINE_VERSION, ENGINE_READ_ERROR, EngineIoError } from './engine'
import { handyDataDirectory } from './discovery'
import { WINDOWS_SPEECH_RUNTIME_HINT } from './runtime-hint'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), manual: false, manualLoad: false }))
vi.mock('./engine-releases.json', async () => {
  const { createHash } = await import('node:crypto')
  const host =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'macos'
        : process.platform
  const cpu =
    process.arch === 'x64'
      ? 'x86_64'
      : process.platform === 'linux' && process.arch === 'arm64'
        ? 'aarch64'
        : process.arch
  const backend =
    process.platform === 'darwin' ? (process.arch === 'arm64' ? 'metal' : 'cpu') : 'cpu-vulkan'
  const library =
    process.platform === 'win32'
      ? 'transcribe.dll'
      : process.platform === 'darwin'
        ? 'libtranscribe.dylib'
        : 'libtranscribe.so'
  const files = Object.fromEntries(
    Object.entries({
      [library]: 'native fixture',
      'contract.json': JSON.stringify({ version: '0.4.1', header_hash: 'f99ad4169374b8f3' }),
    }).map(([key, value]) => [
      key,
      { size: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') },
    ]),
  )
  return {
    default: [
      {
        filename: `transcribe-native-0.4.1-${host}-${cpu}-${backend}.tar.gz`,
        size: 0,
        sha256: '',
        url: '',
        files,
      },
    ],
  }
})
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  mocks.fork.mockImplementation(() => {
    const child = new EventEmitter()
    return Object.assign(child, {
      postMessage: vi.fn(
        (request: { id: number; kind: string; path: string; pcm?: Float32Array }) => {
          if (mocks.manual && request.kind === 'transcribe') return
          if (mocks.manualLoad && request.kind === 'load') return
          queueMicrotask(() => {
            child.emit('message', { id: request.id, started: true })
            child.emit(
              'message',
              request.path.includes('invalid')
                ? { id: request.id, error: 'Invalid GGUF model' }
                : {
                    id: request.id,
                    result: { text: request.kind === 'transcribe' ? 'local transcript' : '' },
                  },
            )
          })
        },
      ),
      kill: vi.fn(() => child.emit('exit', 0)),
    })
  })
  return { utilityProcess: { fork: mocks.fork } }
})
const roots: string[] = []
const verifyFixture = engineModule.verifyInstalledEngine
const services: SpeechService[] = []
beforeEach(() => {
  mocks.fork.mockClear()
  mocks.manual = false
  mocks.manualLoad = false
})
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup(engine = true, initialize = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ari-speech-service-'))
  roots.push(dir)
  vi.stubEnv('APPDATA', dir)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('XDG_DATA_HOME', dir)
  vi.stubEnv('HF_HUB_CACHE', join(dir, 'cache', 'hub'))
  vi.stubEnv('HF_HOME', join(dir, 'cache'))
  vi.stubEnv('PATH', '')
  if (engine) await createEngine(dir)
  const store = new SettingsStore({ dir })
  const service = new SpeechService(dir, store)
  services.push(service)
  if (engine && initialize) await vi.waitFor(() => expect(service.status().engine).toBe('ready'))
  return { dir, store, service }
}
async function createEngine(dir: string) {
  const native = join(dir, 'speech', 'engine', '0.4.1')
  await mkdir(native, { recursive: true })
  await writeFile(
    join(native, 'contract.json'),
    JSON.stringify({ version: ENGINE_VERSION, header_hash: ENGINE_HEADER_HASH }),
  )
  await writeFile(
    join(
      native,
      process.platform === 'win32'
        ? 'transcribe.dll'
        : process.platform === 'darwin'
          ? 'libtranscribe.dylib'
          : 'libtranscribe.so',
    ),
    'native fixture',
  )
  return join(
    native,
    process.platform === 'win32'
      ? 'transcribe.dll'
      : process.platform === 'darwin'
        ? 'libtranscribe.dylib'
        : 'libtranscribe.so',
  )
}
async function selectReady(service: SpeechService, choice: { modelId?: string; path?: string }) {
  await service.select(choice)
  await vi.waitFor(() => expect(service.status().ready).toBe(true), { timeout: 3000 })
}
async function installFixture(dir: string, verified?: (stamp: string) => void) {
  const library = await createEngine(dir)
  await verifyFixture(join(dir, 'speech', 'engine', ENGINE_VERSION), true, undefined, verified)
  return library
}
it('keeps the mic unarmed until a model is configured', async () => {
  const { service } = await setup(false)
  expect(await service.status()).toMatchObject({ engine: 'missing', model: null, ready: false })
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow('Settings')
  expect(mocks.fork).not.toHaveBeenCalled()
})
it('uses one warm inference process and clears selection when its own model is removed', async () => {
  const { dir, store, service } = await setup()
  const folder = join(dir, 'speech', 'models')
  await mkdir(folder, { recursive: true })
  const path = join(folder, 'custom.gguf')
  await writeFile(path, 'gguf')
  const entry = (await service.models()).find(
    (model) => model.installed && model.installed.path === path,
  )!
  await selectReady(service, { modelId: entry.id })
  expect(await service.transcribe(new Float32Array([0.1]))).toEqual({ text: 'local transcript' })
  await service.transcribe(new Float32Array([0.2]))
  expect(mocks.fork).toHaveBeenCalledOnce()
  await service.remove(entry.id)
  expect(store.current.speech).toMatchObject({ enabled: false, modelPath: null, modelId: null })
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('never removes Handy models and leaves an invalid selected model unarmed', async () => {
  const { dir, service } = await setup()
  const folder = join(handyDataDirectory(process.platform, dir, process.env), 'models')
  await mkdir(folder, { recursive: true })
  const path = join(folder, 'invalid.gguf')
  await writeFile(path, 'not a model')
  const entry = (await service.models()).find(
    (model) => model.installed && model.installed.path === path,
  )!
  await expect(service.remove(entry.id)).rejects.toThrow('Only models downloaded by Ari')
  expect(await service.select({ modelId: entry.id })).toMatchObject({ ready: false })
  await vi.waitFor(() =>
    expect(service.status()).toMatchObject({ ready: false, error: 'Invalid GGUF model' }),
  )
  expect(await readFile(path, 'utf8')).toBe('not a model')
})

it('rechecks deleted and tampered engines and offers reinstall instead of stale ready', async () => {
  const { dir, service } = await setup()
  expect((await service.status()).engine).toBe('ready')
  const native = join(dir, 'speech', 'engine', ENGINE_VERSION)
  await rm(join(native, 'contract.json'))
  await vi.waitFor(
    () => expect(service.status()).toMatchObject({ engine: 'missing', ready: false }),
    { timeout: 3000 },
  )
  const other = await setup()
  await other.service.status()
  const path = join(other.dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  const library =
    process.platform === 'win32'
      ? 'transcribe.dll'
      : process.platform === 'darwin'
        ? 'libtranscribe.dylib'
        : 'libtranscribe.so'
  await writeFile(join(other.dir, 'speech', 'engine', ENGINE_VERSION, library), 'NATIVE FIXTURE')
  await other.store.update({ speech: { modelPath: path, enabled: true } })
  await expect(other.service.transcribe(new Float32Array([0]))).rejects.toThrow(
    'The speech engine is missing or changed',
  )
  expect(await other.service.status()).toMatchObject({ engine: 'missing', ready: false })
  expect(mocks.fork).not.toHaveBeenCalled()
})

it('clears an engine verification error after explicit inspection of repaired files', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  const library = await verifyFixture(join(dir, 'speech', 'engine', ENGINE_VERSION), false)
  await writeFile(library!, 'NATIVE FIXTURE')
  await service.select({ path })
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'configuration')?.status).toMatchObject({
      engine: 'missing',
      loading: false,
      error: expect.stringContaining('missing or changed'),
    }),
  )
  const installer = vi.spyOn(engineModule, 'installEngine')
  await createEngine(dir)
  await service.check()
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'configuration')?.status).toMatchObject({
      engine: 'ready',
      ready: true,
      error: null,
    }),
  )
  expect(service.snapshot().find((frame) => frame.id === 'configuration')?.error).toBeUndefined()
  expect(installer).not.toHaveBeenCalled()
})

it('uses generous audio and model budgets and starts no timer for queued dictations', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  mocks.manual = true
  const child = mocks.fork.mock.results[0]!.value
  const first = service.transcribe(new Float32Array(16_000 * 60))
  const second = service.transcribe(new Float32Array([0]))
  while (child.postMessage.mock.calls.length < 3)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const requests = child.postMessage.mock.calls.map(
    ([request]: [{ id: number; pcm?: Float32Array }]) => request,
  )
  const firstId = requests.find(
    (request: { pcm?: Float32Array }) => request.pcm?.length === 16_000 * 60,
  )!.id
  const secondId = requests.find((request: { pcm?: Float32Array }) => request.pcm?.length === 1)!.id
  vi.useFakeTimers()
  child.emit('message', { id: firstId, started: true })
  await vi.advanceTimersByTimeAsync(6 * 60_000)
  expect(child.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(child.kill).not.toHaveBeenCalled()
  child.emit('message', { id: firstId, result: { text: 'long' } })
  expect(await first).toEqual({ text: 'long' })
  child.emit('message', { id: secondId, started: true })
  const rejected = expect(second).rejects.toThrow('took too long')
  await vi.advanceTimersByTimeAsync(speechRequestTimeout('transcribe', 1))
  await rejected
  expect(child.kill).toHaveBeenCalledOnce()
  expect(speechRequestTimeout('transcribe', 16_000 * 300, 2_000_000_000)).toBeGreaterThan(
    speechRequestTimeout('transcribe', 16_000 * 300, 100_000_000),
  )
})

async function idleRequestFixture() {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  mocks.manual = true
  const child = mocks.fork.mock.results[0]!.value
  // An alive worker may ignore kill without delivering an exit event.
  child.kill.mockImplementation(() => true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = service.transcribe(new Float32Array([0]))
  while (child.postMessage.mock.calls.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
  return { service, child, pending, id: child.postMessage.mock.calls[1][0].id }
}

it('bounds idle dispatch acknowledgment and settles every request without a worker exit', async () => {
  const { service, child, pending } = await idleRequestFixture()
  const outcomes = [pending.catch((error: Error) => error.message)]
  await vi.advanceTimersByTimeAsync(30_000)
  const queued = service.transcribe(new Float32Array([0]))
  outcomes.push(queued.catch((error: Error) => error.message))
  while (child.postMessage.mock.calls.length < 3)
    await new Promise<void>((resolve) => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(29_999)
  expect(child.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(child.kill).toHaveBeenCalledOnce()
  expect(await Promise.all(outcomes)).toEqual([
    'The speech engine did not start the request. Please retry.',
    'The speech engine did not start the request. Please retry.',
  ])
})

it('pauses the dispatch watchdog during inference and rearms it for the next idle request', async () => {
  const { service, child, pending, id } = await idleRequestFixture()
  const queued = service.transcribe(new Float32Array([0]))
  const outcome = queued.catch((error: Error) => error.message)
  while (child.postMessage.mock.calls.length < 3)
    await new Promise<void>((resolve) => setImmediate(resolve))
  child.emit('message', { id, started: true })
  await vi.advanceTimersByTimeAsync(9 * 60_000)
  expect(child.kill).not.toHaveBeenCalled()
  child.emit('message', { id, result: { text: 'first' } })
  expect(await pending).toEqual({ text: 'first' })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(child.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(child.kill).toHaveBeenCalledOnce()
  expect(await outcome).toContain('did not start the request')
})

it('settles queued requests at the inference budget even when kill never emits exit', async () => {
  const { service, child, pending, id } = await idleRequestFixture()
  const outcomes = [pending.catch((error: Error) => error.message)]
  outcomes.push(service.transcribe(new Float32Array([0])).catch((error: Error) => error.message))
  while (child.postMessage.mock.calls.length < 3)
    await new Promise<void>((resolve) => setImmediate(resolve))
  child.emit('message', { id, started: true })
  await vi.advanceTimersByTimeAsync(speechRequestTimeout('transcribe', 1))
  expect(child.kill).toHaveBeenCalledOnce()
  expect(await Promise.all(outcomes)).toEqual([
    'Speech to text took too long. Try a smaller model or a shorter recording.',
    'Speech to text took too long. Try a smaller model or a shorter recording.',
  ])
})

it('settles pending dispatch on dispose without relying on an exit event', async () => {
  const { service, child, pending, id } = await idleRequestFixture()
  const outcome = pending.catch((error: Error) => error.message)
  service.dispose()
  expect(await outcome).toContain('Speech service stopped')
  child.emit('message', { id, started: true })
  child.emit('message', { id, result: { text: 'late' } })
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
  expect(child.kill).toHaveBeenCalledOnce()
})

it('cleans up pending requests when postMessage throws without an exit event', async () => {
  const { service, child, pending } = await idleRequestFixture()
  const firstOutcome = pending.catch((error: Error) => error.message)
  child.postMessage.mockImplementation(() => {
    throw new Error('dispatch failed')
  })
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow(
    'The speech engine could not receive the request',
  )
  expect(await firstOutcome).toContain('could not receive the request')
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
  expect(child.kill).toHaveBeenCalledOnce()
})

it('bounds an unacknowledged bootstrap load and reports a recoverable configuration error', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  mocks.manualLoad = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await service.select({ path })
  while (!mocks.fork.mock.results[0]?.value.postMessage.mock.calls.length)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const child = mocks.fork.mock.results[0]!.value
  child.kill.mockImplementation(() => true)
  const outcome = service.transcribe(new Float32Array([0])).catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await outcome).toContain('did not start the request')
  expect(service.status()).toMatchObject({
    ready: false,
    loading: false,
    error: expect.stringContaining('did not start'),
  })
  expect(child.kill).toHaveBeenCalledOnce()
})

it('does not let unknown acknowledgments extend stalled dispatch or duplicate a stopping worker', async () => {
  const { service, child, pending, id } = await idleRequestFixture()
  const outcome = pending.catch((error: Error) => error.message)
  child.emit('message', { id: id + 100, started: true })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await outcome).toContain('did not start the request')
  const retry = service.transcribe(new Float32Array([0])).catch((error: Error) => error.message)
  // Wait for the actual stop boundary before advancing its virtual deadline.
  while (child.listenerCount('exit') < 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(5000)
  expect(await retry).toContain('did not stop')
  expect(mocks.fork).toHaveBeenCalledOnce()
  expect(child.kill).toHaveBeenCalledOnce()
})

it.each(['false', 'throw'])(
  'retains the stopping worker after kill %s until a confirmed exit',
  async (failure) => {
    const { service, child, pending } = await idleRequestFixture()
    child.kill.mockImplementation(() => {
      if (failure === 'throw') throw new Error('Kill unsuccessful')
      return false
    })
    const outcome = pending.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await outcome).toContain('did not start the request')
    const retry = service.transcribe(new Float32Array([0])).catch((error: Error) => error.message)
    while (child.listenerCount('exit') < 2)
      await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(5000)
    expect(await retry).toContain('did not stop')
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 0)
    mocks.manual = false
    expect(await service.transcribe(new Float32Array([0]))).toEqual({ text: 'local transcript' })
    expect(mocks.fork).toHaveBeenCalledTimes(2)
  },
)

it.each(['false', 'throw'])(
  'waits for confirmed exit when the first engine-inspection stop kill %s fails',
  async (failure) => {
    const { dir, service } = await setup()
    const path = join(dir, 'custom.gguf')
    await writeFile(path, 'gguf')
    await selectReady(service, { path })
    mocks.manual = true
    const child = mocks.fork.mock.results[0]!.value
    child.kill.mockImplementation(() => {
      if (failure === 'throw') throw new Error('Kill unsuccessful')
      return false
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = service.transcribe(new Float32Array([0]))
    const outcome = pending.catch((error: Error) => error.message)
    while (child.postMessage.mock.calls.length < 2)
      await new Promise<void>((resolve) => setImmediate(resolve))
    child.emit('message', { id: child.postMessage.mock.calls[1][0].id, started: true })
    const inspection = vi.spyOn(engineModule, 'verifyInstalledEngine').mockResolvedValueOnce(null)
    let settled = false
    const check = service.check().catch((error: Error) => {
      settled = true
      return error.message
    })
    while (child.listenerCount('exit') < 2)
      await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await outcome).toContain('The speech engine stopped')
    expect(child.kill).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await check).toContain('did not stop')
    expect(child.listenerCount('exit')).toBe(1)
    expect(mocks.fork).toHaveBeenCalledOnce()
    // Files may recover before the old process exits. Keep the refusal visible;
    // no new inference process may bypass that stopping identity.
    inspection.mockRestore()
    await service.check()
    const retry = service.transcribe(new Float32Array([0])).catch((error: Error) => error.message)
    while (child.listenerCount('exit') < 2)
      await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(5000)
    expect(await retry).toContain('did not stop')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(mocks.fork).toHaveBeenCalledOnce()
    child.emit('exit', 0)
    mocks.manual = false
    await service.select({ path })
    expect(await service.transcribe(new Float32Array([0]))).toEqual({ text: 'local transcript' })
    expect(mocks.fork).toHaveBeenCalledTimes(2)
  },
)

it('transcribes more than five minutes of valid audio with a duration-scaled failure budget', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  mocks.manual = true
  const child = mocks.fork.mock.results[0]!.value
  const pcm = new Float32Array(16_000 * 360 + 1).fill(0.25)
  pcm[pcm.length - 1] = 0.75
  const pending = service.transcribe(pcm)
  while (child.postMessage.mock.calls.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const request = child.postMessage.mock.calls[1][0]
  expect(request.pcm).toBe(pcm)
  expect(request.pcm.at(-1)).toBe(0.75)
  vi.useFakeTimers()
  child.emit('message', { id: request.id, started: true })
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(child.kill).not.toHaveBeenCalled()
  child.emit('message', { id: request.id, result: { text: 'Full long dictation' } })
  expect(await pending).toEqual({ text: 'Full long dictation' })
  await vi.advanceTimersByTimeAsync(speechRequestTimeout('transcribe', pcm.length))
  expect(child.kill).not.toHaveBeenCalled()
})

it.each([
  new Float32Array(),
  new Float32Array([NaN]),
  new Float32Array([Infinity]),
  new Float32Array([1.1]),
  new Float32Array([-1.1]),
])('rejects empty or invalid recordings before starting inference (%s)', async (pcm) => {
  const { service } = await setup(false, false)
  await expect(service.transcribe(pcm)).rejects.toThrow('Invalid recording')
  expect(mocks.fork).not.toHaveBeenCalled()
})

it('reports worker exits without blaming the Visual C++ runtime', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  mocks.manual = true
  const child = mocks.fork.mock.results[0]!.value
  const pending = service.transcribe(new Float32Array([0]))
  while (child.postMessage.mock.calls.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const rejected = expect(pending).rejects.toThrow('The speech engine stopped. Please retry.')
  child.kill()
  await rejected
})

it('discards partials explicitly and preserves them when selecting a different model', async () => {
  const { dir, service } = await setup()
  const root = join(dir, 'speech', 'models')
  await mkdir(root, { recursive: true })
  const model = catalog[0]!
  const partial = join(root, `${model.filename}.partial`)
  await writeFile(partial, 'saved')
  expect(await service.discard(model.id)).toEqual({ discarded: true })
  await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(partial, 'saved again')
  const path = join(root, 'custom.gguf')
  await writeFile(path, 'gguf')
  await service.select({ path })
  expect(await readFile(partial, 'utf8')).toBe('saved again')
})

it('waits for a cancelled download to close before discarding its partial', async () => {
  const { dir, service } = await setup()
  const model = catalog.find((model) => model.size < 100_000_000)!
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, options: { signal: AbortSignal }) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              options.signal.addEventListener('abort', () =>
                controller.error(new Error('cancelled')),
              )
              controller.enqueue(new Uint8Array([1, 2, 3]))
            },
          }),
        ),
      ),
    ),
  )
  await service.download(model.id)
  const path = join(dir, 'speech', 'models', `${model.filename}.partial`)
  while (!(await readFile(path).catch(() => null))?.length)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const selected = join(dir, 'custom.gguf')
  await writeFile(selected, 'gguf')
  await service.select({ path: selected })
  expect(service.snapshot().find((frame) => frame.id === model.id)?.phase).toBe('downloading')
  await expect(service.discard(model.id)).rejects.toThrow('Cancel the model download')
  service.cancel(model.id)
  while (service.snapshot().find((frame) => frame.id === model.id)?.phase !== 'cancelled')
    await new Promise<void>((resolve) => setImmediate(resolve))
  expect(await service.discard(model.id)).toEqual({ discarded: true })
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(service.snapshot().find((frame) => frame.id === model.id)?.phase).toBe('cancelled')
})

it('verifies fully once before each worker and never on warm dictations', async () => {
  const verify = vi.spyOn(engineModule, 'verifyInstalledEngine')
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  const before = verify.mock.calls.length
  await service.transcribe(new Float32Array([0]))
  await service.transcribe(new Float32Array([0]))
  expect(verify.mock.calls).toHaveLength(before)
  expect(verify.mock.calls.filter(([, full]) => full)).toHaveLength(1)
  mocks.fork.mock.results[0]!.value.kill()
  await service.transcribe(new Float32Array([0]))
  expect(verify.mock.calls.filter(([, full]) => full)).toHaveLength(2)
})

it('serializes status, installation and pre-fork verification while snapshots stay immediate', async () => {
  const { dir, service, store } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await store.update({ speech: { modelPath: path, enabled: true } })
  const originalVerify = engineModule.verifyInstalledEngine
  let finishCheck: () => void = () => undefined
  let finishInstall: () => void = () => undefined
  let active = 0
  let maxActive = 0
  let fullChecks = 0
  vi.spyOn(engineModule, 'verifyInstalledEngine').mockImplementation(
    async (root, full, release, stamp) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (full) {
          fullChecks++
          await new Promise<void>((resolve) => {
            finishCheck = resolve
          })
          return null
        }
        return await originalVerify(root, full, release, stamp)
      } finally {
        active--
      }
    },
  )
  const install = vi
    .spyOn(engineModule, 'installEngine')
    .mockImplementation(async (_root, _signal, _progress, stamp) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise<void>((resolve) => {
          finishInstall = resolve
        })
        return await installFixture(dir, stamp)
      } finally {
        active--
      }
    })
  const transcription = service.transcribe(new Float32Array([0])).catch((error: unknown) => error)
  await vi.waitFor(() => expect(fullChecks).toBe(1))
  const first = service.install()
  const second = service.install()
  const status = service.status()
  expect(status).not.toBeInstanceOf(Promise)
  expect(install).not.toHaveBeenCalled()
  expect(await second).toEqual({ started: false })
  expect(await first).toEqual({ started: false })
  finishCheck()
  await transcription
  expect(await service.install()).toEqual({ started: true })
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
  for (let i = 0; i < 10; i++) expect(service.status().engine).toBe('downloading')
  finishInstall()
  await vi.waitFor(() => expect(service.status()).toMatchObject({ engine: 'ready', ready: true }))
  expect(maxActive).toBe(1)
  expect(fullChecks).toBe(1)
})

it('reports transient engine I/O without killing a warm worker or marking it missing', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 60_001)
  const verification = vi
    .spyOn(engineModule, 'verifyInstalledEngine')
    .mockRejectedValue(new EngineIoError('Temporarily locked. Retry.'))
  await vi.waitFor(
    () =>
      expect(service.status()).toMatchObject({
        engine: 'ready',
        ready: true,
        error: ENGINE_READ_ERROR,
      }),
    { timeout: 3000 },
  )
  expect(await service.install()).toEqual({ started: false })
  expect(mocks.fork.mock.results[0]!.value.kill).not.toHaveBeenCalled()
  const reads = verification.mock.calls.length
  expect(await service.transcribe(new Float32Array([0]))).toEqual({ text: 'local transcript' })
  expect(verification).toHaveBeenCalledTimes(reads)
})

it('forces a check during model loading even within the recent-verification window', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  mocks.manualLoad = true
  await service.select({ path })
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce())
  const child = mocks.fork.mock.results[0]!.value
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce())
  const verification = vi.spyOn(engineModule, 'verifyInstalledEngine')
  expect(await service.check()).toMatchObject({
    engine: 'ready',
    loading: true,
    ready: false,
    error: null,
  })
  expect(verification.mock.calls.filter(([, full]) => full)).toHaveLength(1)
  child.emit('message', { id: child.postMessage.mock.calls[0][0].id, result: { text: '' } })
  await vi.waitFor(() => expect(service.status().ready).toBe(true))
})

it('offers reinstall after a forced read check fails and replaces files without rechecking the locked install', async () => {
  const { dir, service } = await setup()
  expect(await service.reinstall()).toEqual({ started: false })
  const inspection = vi
    .spyOn(engineModule, 'verifyInstalledEngine')
    .mockRejectedValue(new EngineIoError('Persistent read failure'))
  const installer = vi
    .spyOn(engineModule, 'installEngine')
    .mockImplementation((_root, _signal, _progress, stamp) => installFixture(dir, stamp))
  const status = await service.check()
  expect(status).toMatchObject({
    engine: 'ready',
    engineInstallable: false,
    engineReinstallable: true,
    error: ENGINE_READ_ERROR,
  })
  const reads = inspection.mock.calls.length
  expect(await service.reinstall()).toEqual({ started: true })
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('complete'),
  )
  expect(installer).toHaveBeenCalledOnce()
  expect(inspection).toHaveBeenCalledTimes(reads)
  expect(service.status()).toMatchObject({
    engine: 'ready',
    engineReinstallable: false,
    error: null,
  })
})

it('retries a failed installation through check and exposes reinstall if that retry has another read error', async () => {
  const { service } = await setup(false, false)
  const installer = vi
    .spyOn(engineModule, 'installEngine')
    .mockRejectedValue(new EngineIoError('Staging files locked'))
  await service.install()
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('error'),
  )
  expect(await service.check()).toMatchObject({
    engine: 'missing',
    engineInstallable: false,
    engineReinstallable: true,
    error: ENGINE_READ_ERROR,
  })
  expect(installer).toHaveBeenCalledTimes(2)
})

it('clears a stale install error frame when a read failure replaces it and the engine becomes missing', async () => {
  const { dir, service, store } = await setup(false, false)
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await store.update({ speech: { modelPath: path, enabled: true } })
  vi.spyOn(engineModule, 'installEngine').mockRejectedValue(new Error('Install failed'))
  await service.install()
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('error'),
  )
  vi.spyOn(engineModule, 'verifyInstalledEngine').mockRejectedValueOnce(
    new EngineIoError('Files locked'),
  )
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow(ENGINE_READ_ERROR)
  expect(await service.check()).toMatchObject({ engine: 'missing', error: null })
  expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('complete')
  expect(service.snapshot().find((frame) => frame.id === 'engine')?.error).toBeUndefined()
})

it('offers the official VC++ runtime link only for unexplained early Windows crashes', () => {
  expect(speechWorkerExitError('win32', -1073741819, false, false)).toContain(
    WINDOWS_SPEECH_RUNTIME_HINT,
  )
  for (const [platform, code, loaded, knownCause] of [
    ['win32', 0, false, false],
    ['win32', 1, true, false],
    ['win32', 1, false, true],
    ['darwin', 1, false, false],
  ] as const)
    expect(speechWorkerExitError(platform, code, loaded, knownCause)).not.toContain('Visual C++')
})

it('reports a crash after a successful load without the runtime hint', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await selectReady(service, { path })
  mocks.manual = true
  const child = mocks.fork.mock.results[0]!.value
  const pending = service.transcribe(new Float32Array([0]))
  while (child.postMessage.mock.calls.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const rejected = expect(pending).rejects.toThrow('The speech engine stopped. Please retry.')
  child.emit('exit', -1073741819)
  await rejected
})

it('shows the shared runtime hint when the worker dies before loading a model', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  mocks.manualLoad = true
  expect(await service.select({ path })).toMatchObject({ ready: false, loading: true })
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce())
  const child = mocks.fork.mock.results[0]!.value
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce())
  child.emit('exit', -1073741819)
  await vi.waitFor(() =>
    expect(service.status().error).toContain(
      process.platform === 'win32' ? WINDOWS_SPEECH_RUNTIME_HINT : 'The speech engine stopped',
    ),
  )
})

it('does not install when startup inspection fails with an I/O error', async () => {
  const { dir, service } = await setup(false, false)
  vi.spyOn(engineModule, 'verifyInstalledEngine').mockRejectedValueOnce(
    new EngineIoError('Old folder is locked.'),
  )
  const install = vi
    .spyOn(engineModule, 'installEngine')
    .mockImplementation((_root, _signal, _progress, stamp) => installFixture(dir, stamp))
  expect(await service.install()).toEqual({ started: true })
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('complete'),
  )
  expect(service.snapshot().find((frame) => frame.id === 'configuration')?.status).toMatchObject({
    engine: 'missing',
    engineInstallable: false,
    error: ENGINE_READ_ERROR,
  })
  expect(await service.install()).toEqual({ started: false })
  expect(install).not.toHaveBeenCalled()
})

it('stops an install read error without changing the last known engine state or retrying', async () => {
  const { service } = await setup(false, false)
  const installer = vi
    .spyOn(engineModule, 'installEngine')
    .mockRejectedValue(new EngineIoError('Staging files locked.'))
  expect(await service.install()).toEqual({ started: true })
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('error'),
  )
  expect(service.snapshot().find((frame) => frame.id === 'engine')).toMatchObject({
    error: ENGINE_READ_ERROR,
    status: { engine: 'missing', engineInstallable: false, error: ENGINE_READ_ERROR },
  })
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(vi.getTimerCount()).toBe(0)
  expect(installer).toHaveBeenCalledOnce()
  expect(await service.install()).toEqual({ started: false })
})

it('leaves a transient pre-fork error alone until the next dictation attempt', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  const originalVerify = engineModule.verifyInstalledEngine
  let failed = false
  const verification = vi
    .spyOn(engineModule, 'verifyInstalledEngine')
    .mockImplementation((root, full, release, stamp) => {
      if (full && !failed) {
        failed = true
        return Promise.reject(new EngineIoError('Temporarily locked.'))
      }
      return originalVerify(root, full, release, stamp)
    })
  const frames: SpeechProgress[] = []
  service.publish = (frame) => frames.push(frame)
  expect(await service.select({ path })).toMatchObject({ ready: false })
  await vi.waitFor(() =>
    expect(frames.some((frame) => frame.status?.error === ENGINE_READ_ERROR)).toBe(true),
  )
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(verification.mock.calls.filter(([, full]) => full)).toHaveLength(1)
  expect(frames.at(-1)?.status).toMatchObject({
    engine: 'ready',
    ready: false,
    error: ENGINE_READ_ERROR,
  })
  vi.useRealTimers()
  expect(await service.transcribe(new Float32Array([0]))).toEqual({ text: 'local transcript' })
  expect(verification.mock.calls.filter(([, full]) => full)).toHaveLength(2)
  expect(frames.at(-1)?.status).toMatchObject({ ready: true, error: null })
})

it('never caches a rejected initialization promise', async () => {
  const { service, store } = await setup(false, false)
  const originalLoad = store.load.bind(store)
  const load = vi
    .spyOn(store, 'load')
    .mockRejectedValueOnce(new Error('Settings temporarily blocked.'))
    .mockImplementation(originalLoad)
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow(
    'Settings temporarily blocked',
  )
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow('Set up speech to text')
  expect(load).toHaveBeenCalledTimes(2)
})

it('does not reinstall or stop a ready worker, including an install queued behind verification', async () => {
  const { dir, service, store } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await store.update({ speech: { modelPath: path, enabled: true } })
  const originalVerify = engineModule.verifyInstalledEngine
  let release: () => void = () => undefined
  let verifying = false
  vi.spyOn(engineModule, 'verifyInstalledEngine').mockImplementation(
    async (root, full, model, stamp) => {
      if (full) {
        verifying = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return originalVerify(root, full, model, stamp)
    },
  )
  const installer = vi.spyOn(engineModule, 'installEngine')
  const transcription = service.transcribe(new Float32Array([0]))
  await vi.waitFor(() => expect(verifying).toBe(true))
  const install = service.install()
  expect(service.status()).not.toBeInstanceOf(Promise)
  expect(await install).toEqual({ started: false })
  release()
  expect(await transcription).toEqual({ text: 'local transcript' })
  const worker = mocks.fork.mock.results[0]!.value
  expect(await service.install()).toEqual({ started: false })
  expect(installer).not.toHaveBeenCalled()
  expect(worker.kill).not.toHaveBeenCalled()
})

it('coalesces refresh requests and publishes the selected model after a delayed scan', async () => {
  const { dir, service, store } = await setup()
  const first = join(dir, 'first.gguf')
  const second = join(dir, 'second.gguf')
  await writeFile(first, 'gguf')
  await writeFile(second, 'gguf')
  await store.update({ speech: { modelPath: first, enabled: true } })
  const scan = service.models.bind(service)
  let release: () => void = () => undefined
  const models = vi.spyOn(service, 'models').mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return scan()
  })
  const frames: SpeechProgress[] = []
  service.publish = (frame) => frames.push(frame)
  mocks.manualLoad = true
  service.status()
  await vi.waitFor(() => expect(models).toHaveBeenCalledOnce())
  await store.update({ speech: { modelPath: second } })
  for (let i = 0; i < 10; i++) service.status()
  release()
  await vi.waitFor(() =>
    expect(frames.at(-1)?.status).toMatchObject({
      ready: false,
      model: { installed: { path: second } },
    }),
  )
  expect(models.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(models.mock.calls.length).toBeLessThan(10)
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce())
  const requests = mocks.fork.mock.results[0]!.value.postMessage.mock.calls
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  expect(requests.every(([request]: [{ path: string }]) => request.path === second)).toBe(true)
  mocks.fork.mock.results[0]!.value.emit('message', {
    id: requests[0][0].id,
    result: { text: '' },
  })
  await vi.waitFor(() => expect(frames.at(-1)?.status?.ready).toBe(true))
})

it('selects another model while an earlier model is loading and publishes readiness only for the new model', async () => {
  const { dir, service } = await setup()
  const first = join(dir, 'first.gguf')
  const second = join(dir, 'second.gguf')
  await writeFile(first, 'gguf')
  await writeFile(second, 'gguf')
  mocks.manualLoad = true
  expect(await service.select({ path: first })).toMatchObject({ ready: false })
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce())
  const child = mocks.fork.mock.results[0]!.value
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce())
  const frames: SpeechProgress[] = []
  service.publish = (frame) => frames.push(frame)
  expect(await service.select({ path: second })).toMatchObject({ ready: false })
  await vi.waitFor(() => expect(service.status().model?.installed).toMatchObject({ path: second }))
  child.emit('message', { id: child.postMessage.mock.calls[0][0].id, result: { text: '' } })
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2))
  expect(frames.some((frame) => frame.status?.ready)).toBe(false)
  child.emit('message', { id: child.postMessage.mock.calls[1][0].id, result: { text: '' } })
  await vi.waitFor(() =>
    expect(frames.at(-1)?.status).toMatchObject({
      ready: true,
      model: { installed: { path: second } },
    }),
  )
})

it('keeps model discard, selection and download responsive during an engine install', async () => {
  const { dir, service } = await setup(false, false)
  let finish: () => void = () => undefined
  vi.spyOn(engineModule, 'installEngine').mockImplementation(
    async (_root, _signal, _progress, stamp) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return installFixture(dir, stamp)
    },
  )
  expect(await service.install()).toEqual({ started: true })
  expect(await service.install()).toEqual({ started: false })
  const root = join(dir, 'speech', 'models')
  await mkdir(root, { recursive: true })
  const partialModel = catalog[0]!
  await writeFile(join(root, `${partialModel.filename}.partial`), 'partial')
  expect(await service.discard(partialModel.id)).toEqual({ discarded: true })
  const path = join(root, 'custom.gguf')
  await writeFile(path, 'gguf')
  expect(await service.select({ path })).toMatchObject({ engine: 'downloading', ready: false })
  const downloader = vi
    .spyOn(downloadModule, 'downloadFile')
    .mockImplementation(async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      signal.throwIfAborted()
    })
  const downloadModel = catalog[1]!
  expect(await service.download(downloadModel.id)).toEqual({ started: true })
  await vi.waitFor(() => expect(downloader).toHaveBeenCalledOnce())
  service.cancel(downloadModel.id)
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === downloadModel.id)?.phase).toBe(
      'cancelled',
    ),
  )
  finish()
  await vi.waitFor(() => expect(service.status().ready).toBe(true))
})

it('preserves installation failure messages through status checks until an explicit retry succeeds', async () => {
  const { dir, service } = await setup(false, false)
  const installer = vi
    .spyOn(engineModule, 'installEngine')
    .mockRejectedValueOnce(new Error('Not enough disk space.'))
    .mockImplementation(() => createEngine(dir))
  expect(await service.install()).toEqual({ started: true })
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('error'),
  )
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 2000)
  for (let i = 0; i < 10; i++)
    expect(service.status()).toMatchObject({ engine: 'error', error: 'Not enough disk space.' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(service.status()).toMatchObject({ engine: 'error', error: 'Not enough disk space.' })
  expect(await service.check()).toMatchObject({ engine: 'ready', error: null })
  await vi.waitFor(() => expect(service.status()).toMatchObject({ engine: 'ready', error: null }))
  expect(installer).toHaveBeenCalledTimes(2)
})

it.each(['immediate', 'expired', 'changed', 'extra-file', 'extra-folder'] as const)(
  'reuses install verification for only one recent, unchanged spawn (%s)',
  async (mode) => {
    const { dir, service } = await setup(false, false)
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const originalVerify = engineModule.verifyInstalledEngine
    const verification = vi.spyOn(engineModule, 'verifyInstalledEngine')
    vi.spyOn(engineModule, 'installEngine').mockImplementation(
      async (root, _signal, _progress, stamp) => {
        const library = await createEngine(dir)
        await originalVerify(join(root, ENGINE_VERSION), true, undefined, stamp)
        return library
      },
    )
    expect(await service.install()).toEqual({ started: true })
    await vi.waitFor(() =>
      expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('complete'),
    )
    const path = join(dir, 'custom.gguf')
    await writeFile(path, 'gguf')
    if (mode === 'expired') now += 60_001
    if (mode === 'changed') {
      const library = await originalVerify(join(dir, 'speech', 'engine', ENGINE_VERSION), false)
      await writeFile(library!, 'NATIVE FIXTURE')
      await utimes(library!, new Date(now), new Date(now + 1000))
    }
    if (mode === 'extra-file')
      await writeFile(join(dir, 'speech', 'engine', ENGINE_VERSION, 'extra.dll'), 'unexpected')
    if (mode === 'extra-folder') await mkdir(join(dir, 'speech', 'engine', ENGINE_VERSION, 'extra'))
    if (['changed', 'extra-file', 'extra-folder'].includes(mode)) {
      expect(await service.select({ path })).toMatchObject({ ready: false })
      await vi.waitFor(() =>
        expect(
          service.snapshot().find((frame) => frame.id === 'configuration')?.status?.engine,
        ).toBe('missing'),
      )
      expect(mocks.fork).not.toHaveBeenCalled()
    } else {
      await service.select({ path })
      await vi.waitFor(() => expect(service.status().ready).toBe(true))
    }
    expect(verification.mock.calls.filter(([, full]) => full)).toHaveLength(
      mode === 'immediate' ? 0 : 1,
    )
    if (mode === 'immediate') {
      expect(verification.mock.calls.filter(([, full]) => !full)).toHaveLength(1)
      mocks.fork.mock.results[0]!.value.kill()
      await service.transcribe(new Float32Array([0]))
      expect(verification.mock.calls.filter(([, full]) => full)).toHaveLength(1)
    }
  },
)

it('stops after an I/O error and inspects only on forced checks or cold dictation attempts', async () => {
  const { dir, service, store } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await store.update({ speech: { modelPath: path, enabled: true } })
  const originalVerify = engineModule.verifyInstalledEngine
  let attempts = 0
  vi.spyOn(engineModule, 'verifyInstalledEngine').mockImplementation(
    (root, full, release, stamp) => {
      if (full) {
        attempts++
        return Promise.reject(new EngineIoError('Library remains locked.'))
      }
      return originalVerify(root, full, release, stamp)
    },
  )
  const frames: SpeechProgress[] = []
  service.publish = (frame) => frames.push(frame)
  vi.useFakeTimers()
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow(ENGINE_READ_ERROR)
  expect(attempts).toBe(1)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(attempts).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
  service.status()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(attempts).toBe(1)
  expect(await service.check()).toMatchObject({
    error: ENGINE_READ_ERROR,
    engineReinstallable: true,
  })
  await vi.waitFor(() => expect(attempts).toBe(2))
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(attempts).toBe(2)
  await expect(service.transcribe(new Float32Array([0]))).rejects.toThrow(ENGINE_READ_ERROR)
  expect(attempts).toBe(3)
  const errorAt = frames.findIndex((frame) => frame.status?.error === ENGINE_READ_ERROR)
  expect(errorAt).toBeGreaterThanOrEqual(0)
  expect(frames.slice(errorAt).every((frame) => frame.status?.error === ENGINE_READ_ERROR)).toBe(
    true,
  )
  expect(mocks.fork).not.toHaveBeenCalled()
})

it.each(['pending', 'io-error', 'absent'] as const)(
  'auto-installs only after a completed absence check (%s)',
  async (mode) => {
    const { dir, service } = await setup(mode !== 'absent', false)
    const path = join(dir, 'custom.gguf')
    await writeFile(path, 'gguf')
    let release: () => void = () => undefined
    const originalVerify = engineModule.verifyInstalledEngine
    vi.spyOn(engineModule, 'verifyInstalledEngine').mockImplementationOnce(
      async (root, full, data, stamp) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        if (mode === 'io-error') throw new EngineIoError('Old engine is temporarily locked.')
        return originalVerify(root, full, data, stamp)
      },
    )
    const installer = vi
      .spyOn(engineModule, 'installEngine')
      .mockImplementation((_root, _signal, _progress, stamp) => installFixture(dir, stamp))
    const frames: SpeechProgress[] = []
    service.publish = (frame) => frames.push(frame)
    expect(await service.select({ path })).toMatchObject({ engine: 'missing', ready: false })
    expect(installer).not.toHaveBeenCalled()
    release()
    if (mode === 'io-error') {
      await vi.waitFor(() => expect(frames.at(-1)?.status?.error).toBe(ENGINE_READ_ERROR))
      expect(await service.install()).toEqual({ started: false })
      await service.check()
    }
    await vi.waitFor(() => expect(frames.at(-1)?.status).toMatchObject({ ready: true }), {
      timeout: 3000,
    })
    expect(installer).toHaveBeenCalledTimes(mode === 'absent' ? 1 : 0)
  },
)

it.each(['dictation', 'install'] as const)(
  'recovers a valid engine on explicit %s and clears its stale install error frame',
  async (action) => {
    const { dir, service, store } = await setup(false, false)
    const path = join(dir, 'custom.gguf')
    await writeFile(path, 'gguf')
    await store.update({ speech: { modelPath: path, enabled: true } })
    const installer = vi
      .spyOn(engineModule, 'installEngine')
      .mockImplementation(async (_root, _signal, _progress, stamp) => {
        await installFixture(dir, stamp)
        throw new Error('Late install step failed.')
      })
    const frames: SpeechProgress[] = []
    service.publish = (frame) => frames.push(frame)
    expect(await service.install()).toEqual({ started: true })
    await vi.waitFor(() =>
      expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('error'),
    )
    expect(frames.at(-1)?.error).toBe('Late install step failed.')
    if (action === 'dictation')
      expect(await service.transcribe(new Float32Array([0]))).toEqual({ text: 'local transcript' })
    else expect(await service.install()).toEqual({ started: true })
    await vi.waitFor(
      () => expect(frames.at(-1)?.status).toMatchObject({ ready: true, error: null }),
      { timeout: 3000 },
    )
    expect(installer).toHaveBeenCalledOnce()
    expect(service.snapshot().find((frame) => frame.id === 'engine')).toMatchObject({
      phase: 'complete',
    })
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.error).toBeUndefined()
  },
)

it('keeps using the loaded model when saving a different selection fails', async () => {
  const { dir, service, store } = await setup()
  const first = join(dir, 'first.gguf')
  const second = join(dir, 'second.gguf')
  await writeFile(first, 'gguf')
  await writeFile(second, 'gguf')
  await selectReady(service, { path: first })
  let rejectSave: (error: Error) => void = () => undefined
  const save = vi.spyOn(store, 'update').mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject
      }),
  )
  const selection = expect(service.select({ path: second })).rejects.toThrow('Disk is full')
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
  const dictation = service.transcribe(new Float32Array([0]))
  rejectSave(new Error('Disk is full'))
  await selection
  expect(await dictation).toEqual({ text: 'local transcript' })
  const child = mocks.fork.mock.results[0]!.value
  expect(child.postMessage.mock.calls.map(([request]: [{ path: string }]) => request.path)).toEqual(
    [first, first],
  )
  expect(service.status()).toMatchObject({ ready: true, model: { installed: { path: first } } })
})

it('loads the newly selected model before dictation on an already running worker', async () => {
  const { dir, service, store } = await setup()
  const first = join(dir, 'first.gguf')
  const second = join(dir, 'second.gguf')
  await writeFile(first, 'gguf')
  await writeFile(second, 'gguf')
  await selectReady(service, { path: first })
  await store.update({ speech: { modelPath: second } })
  expect(await service.transcribe(new Float32Array([0]))).toEqual({ text: 'local transcript' })
  expect(mocks.fork).toHaveBeenCalledOnce()
  const calls = mocks.fork.mock.results[0]!.value.postMessage.mock.calls
  expect(
    calls
      .slice(-2)
      .map(([request]: [{ kind: string; path: string }]) => [request.kind, request.path]),
  ).toEqual([
    ['load', second],
    ['transcribe', second],
  ])
})

it('returns after saving selection and lets immediate dictation wait for its background load', async () => {
  const { dir, service } = await setup()
  const first = join(dir, 'first.gguf')
  const second = join(dir, 'second.gguf')
  await writeFile(first, 'gguf')
  await writeFile(second, 'gguf')
  await selectReady(service, { path: first })
  mocks.manualLoad = true
  expect(await service.select({ path: second })).toMatchObject({ ready: false, loading: true })
  const child = mocks.fork.mock.results[0]!.value
  await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2))
  const dictation = service.transcribe(new Float32Array([0]))
  child.emit('message', { id: child.postMessage.mock.calls[1][0].id, result: { text: '' } })
  expect(await dictation).toEqual({ text: 'local transcript' })
  expect(child.postMessage).toHaveBeenCalledTimes(3)
})

it('returns an install receipt before queued inspection finishes and releases a cancelled install', async () => {
  const { dir, service } = await setup(false, false)
  let release: () => void = () => undefined
  const inspection = vi
    .spyOn(engineModule, 'verifyInstalledEngine')
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return null
    })
  const installer = vi
    .spyOn(engineModule, 'installEngine')
    .mockImplementation((_root, _signal, _progress, stamp) => installFixture(dir, stamp))
  expect(await service.install()).toEqual({ started: true })
  expect(await service.install()).toEqual({ started: false })
  expect(installer).not.toHaveBeenCalled()
  expect(service.cancel('engine')).toEqual({ cancelled: true })
  await vi.waitFor(() => expect(inspection).toHaveBeenCalledOnce())
  release()
  await vi.waitFor(() =>
    expect(service.snapshot().find((frame) => frame.id === 'engine')?.phase).toBe('cancelled'),
  )
  expect(await service.install()).toEqual({ started: true })
  await vi.waitFor(() => expect(service.status().engine).toBe('ready'), { timeout: 3000 })
  expect(installer).toHaveBeenCalledOnce()
})

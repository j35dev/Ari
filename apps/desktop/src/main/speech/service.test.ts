// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsStore } from '@ari/engine/settings'
import { SpeechService, speechRequestTimeout } from './service'
import { catalog } from './discovery'
import { ENGINE_HEADER_HASH, ENGINE_VERSION } from './engine'
import { handyDataDirectory } from './discovery'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), manual: false }))
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
const services: SpeechService[] = []
beforeEach(() => {
  mocks.fork.mockClear()
  mocks.manual = false
})
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup(engine = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ari-speech-service-'))
  roots.push(dir)
  vi.stubEnv('APPDATA', dir)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('XDG_DATA_HOME', dir)
  vi.stubEnv('HF_HUB_CACHE', join(dir, 'cache', 'hub'))
  vi.stubEnv('HF_HOME', join(dir, 'cache'))
  vi.stubEnv('PATH', '')
  if (engine) {
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
  }
  const store = new SettingsStore({ dir })
  const service = new SpeechService(dir, store)
  services.push(service)
  return { dir, store, service }
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
  expect(await service.select({ modelId: entry.id })).toMatchObject({ ready: true })
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
  await expect(service.select({ modelId: entry.id })).rejects.toThrow('Invalid GGUF')
  expect(await service.status()).toMatchObject({ ready: false, error: 'Invalid GGUF model' })
  expect(await readFile(path, 'utf8')).toBe('not a model')
})

it('rechecks deleted and tampered engines and offers reinstall instead of stale ready', async () => {
  const { dir, service } = await setup()
  expect((await service.status()).engine).toBe('ready')
  const native = join(dir, 'speech', 'engine', ENGINE_VERSION)
  await rm(join(native, 'contract.json'))
  expect(await service.status()).toMatchObject({ engine: 'missing', ready: false })
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
  await expect(other.service.select({ path })).rejects.toThrow('Download the speech engine')
  expect(await other.service.status()).toMatchObject({ engine: 'missing', ready: false })
  expect(mocks.fork).not.toHaveBeenCalled()
})

it('uses generous audio and model budgets and starts no timer for queued dictations', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await service.select({ path })
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

it('reports worker exits without blaming the Visual C++ runtime', async () => {
  const { dir, service } = await setup()
  const path = join(dir, 'custom.gguf')
  await writeFile(path, 'gguf')
  await service.select({ path })
  mocks.manual = true
  const child = mocks.fork.mock.results[0]!.value
  const pending = service.transcribe(new Float32Array([0]))
  while (child.postMessage.mock.calls.length < 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
  const rejected = expect(pending).rejects.toThrow('The speech engine stopped. Please retry.')
  child.kill()
  await rejected
})

it('discards saved Ari partials explicitly and when selecting a different model', async () => {
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
  await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' })
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
  expect(await service.discard(model.id)).toEqual({ discarded: true })
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(service.snapshot().find((frame) => frame.id === model.id)?.phase).toBe('cancelled')
})

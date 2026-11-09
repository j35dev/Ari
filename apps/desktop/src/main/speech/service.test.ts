// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsStore } from '@ari/engine/settings'
import { SpeechService } from './service'
import { handyDataDirectory } from './discovery'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  mocks.fork.mockImplementation(() => {
    const child = new EventEmitter()
    return Object.assign(child, {
      postMessage: (request: { id: number; kind: string; path: string }) =>
        queueMicrotask(() =>
          child.emit(
            'message',
            request.path.includes('invalid')
              ? { id: request.id, error: 'Invalid GGUF model' }
              : {
                  id: request.id,
                  result: { text: request.kind === 'transcribe' ? 'local transcript' : '' },
                },
          ),
        ),
      kill: () => child.emit('exit', 0),
    })
  })
  return { utilityProcess: { fork: mocks.fork } }
})
const roots: string[] = []
const services: SpeechService[] = []
beforeEach(() => mocks.fork.mockClear())
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  vi.unstubAllEnvs()
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

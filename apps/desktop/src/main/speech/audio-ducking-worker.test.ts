// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ volume: 0.8, write: vi.fn(), dispose: vi.fn() }))
vi.mock('./audio-ducking-windows', () => ({
  windowsOutputBackend: () => ({
    list: async () => ({
      complete: true,
      sessions: [
        {
          id: 'test-output',
          read: async () => [mocks.volume],
          write: mocks.write,
          release() {},
        },
      ],
    }),
    dispose: mocks.dispose,
  }),
}))
let directory: string
let port: EventEmitter
let runtime: typeof process
let send: ReturnType<typeof vi.fn>
let exit: ReturnType<typeof vi.fn>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ari-ducking-worker-'))
  vi.resetModules()
  vi.useFakeTimers()
  mocks.volume = 0.8
  mocks.write.mockReset().mockImplementation(async (volume: number[]) => {
    mocks.volume = volume[0]!
  })
  mocks.dispose.mockReset()
  port = new EventEmitter()
  send = vi.fn((_message, callback) => callback?.())
  exit = vi.fn()
  runtime = {
    ...process,
    platform: 'win32',
    argv: ['node', 'helper', join(directory, 'journal.json')],
    connected: true,
    on: port.on.bind(port),
    send,
    exit,
  } as unknown as typeof process
  vi.stubGlobal('process', runtime)
  await import('./audio-ducking-worker')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ ready: true }, expect.any(Function)))
})
afterEach(async () => {
  if (!exit.mock.calls.length) {
    runtime.connected = false
    port.emit('disconnect')
    await vi.waitFor(() => expect(exit).toHaveBeenCalled())
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

it.each(['disconnect', 'SIGTERM', 'SIGINT'])(
  'restores and clears its durable journal on parent %s',
  async (event) => {
    port.emit('message', { active: true, excluded: [1] })
    await vi.waitFor(() => expect(mocks.volume).toBe(0.2))
    expect(JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'))).toMatchObject([
      { original: [0.8], applied: [0.2] },
    ])
    if (event === 'disconnect') runtime.connected = false
    port.emit(event)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(mocks.volume).toBe(0.8)
    expect(mocks.dispose).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'))).toEqual([])
  },
)

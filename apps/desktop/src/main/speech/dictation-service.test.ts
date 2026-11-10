// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'

const mock = vi.hoisted(() => ({
  windows: 'original-window',
  automatic: true,
  children: [] as (EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  })[],
}))
vi.mock('./windows-foreground', () => ({ foregroundWindow: () => mock.windows }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    utilityProcess: {
      fork: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
          postMessage: vi.fn((request: { id: number; kind: string }) => {
            if (mock.automatic)
              queueMicrotask(() =>
                child.emit('message', {
                  id: request.id,
                  result:
                    request.kind === 'snapshot' ? { text: 'draft', start: 1, end: 2 } : undefined,
                }),
              )
          }),
          kill: vi.fn(() => child.emit('exit', 0)),
        })
        mock.children.push(child)
        queueMicrotask(() => child.emit('message', { ready: true }))
        return child
      }),
    },
  }
})
import { WindowsDictationService } from './dictation-service'
let service: WindowsDictationService
beforeEach(() => {
  mock.windows = 'original-window'
  mock.automatic = true
  mock.children.length = 0
  service = new WindowsDictationService()
})
afterEach(() => {
  service.close()
  vi.useRealTimers()
})

it('captures the foreground before asynchronous native work and preserves the target id', async () => {
  await service.prepare()
  const capture = service.capture('session-target')
  mock.windows = 'another-window'
  const target = await capture
  expect(mock.children[0]!.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'capture',
      target: 'session-target',
      window: 'original-window',
    }),
  )
  await target.insert('dictated')
  expect(mock.children[0]!.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'insert', target: 'session-target', text: 'dictated' }),
  )
})
it('cancels instead of sending text after the owning capture was invalidated', async () => {
  const target = await service.capture('old')
  await expect(target.insert('must not insert', () => false)).rejects.toThrow('target changed')
  expect(
    mock.children[0]!.postMessage.mock.calls.some(([request]) => request.kind === 'insert'),
  ).toBe(false)
})
it('rejects every pending operation when the native process exits and can restart', async () => {
  await service.prepare()
  mock.automatic = false
  const capture = service.capture('old')
  const rejected = expect(capture).rejects.toThrow('stopped')
  await vi.waitFor(() => expect(mock.children[0]!.postMessage).toHaveBeenCalled())
  mock.children[0]!.emit('exit', 1)
  await rejected
  mock.automatic = true
  await service.capture('new')
  expect(mock.children).toHaveLength(2)
})
it('kills a hung provider so it cannot apply a late request', async () => {
  vi.useFakeTimers()
  await service.prepare()
  mock.automatic = false
  const capture = service.capture('hung')
  const rejected = expect(capture).rejects.toThrow('could not access')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(mock.children[0]!.kill).toHaveBeenCalledOnce()
})
it('ignores late messages from a stopped worker after restarting', async () => {
  await service.prepare()
  const previous = mock.children[0]!
  service.close()
  await service.capture('new')
  previous.emit('message', { error: 'old worker failed' })
  expect(mock.children[1]!.kill).not.toHaveBeenCalled()
  await expect(service.snapshot('new')).resolves.toEqual({ text: 'draft', start: 1, end: 2 })
})

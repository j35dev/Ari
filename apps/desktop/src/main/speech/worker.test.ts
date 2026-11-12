// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const model = vi.hoisted(() => ({
  load: vi.fn(),
  transcribe: vi.fn(),
  dispose: vi.fn(),
  supports: vi.fn(),
}))
vi.mock('transcribe-cpp', () => ({ TranscribeModel: { load: model.load } }))

let parent: EventEmitter & { postMessage: ReturnType<typeof vi.fn> }
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  model.load.mockReset().mockResolvedValue(model)
  model.transcribe.mockReset().mockResolvedValue({ text: 'Dictation' })
  model.dispose.mockReset()
  model.supports.mockReset().mockReturnValue(false)
  parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
  vi.stubGlobal('process', { ...process, parentPort: parent })
  await import('./worker')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function request(id: number, kind: 'load' | 'transcribe') {
  parent.emit('message', { data: { id, kind, path: 'custom.gguf', pcm: new Float32Array([0.1]) } })
}

it('unloads only after idle time, never while long inference or queued dictation is active', async () => {
  request(1, 'load')
  await vi.waitFor(() =>
    expect(parent.postMessage).toHaveBeenCalledWith({ id: 1, result: { text: '' } }),
  )
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  let finish!: (result: { text: string }) => void
  model.transcribe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  request(2, 'transcribe')
  request(3, 'transcribe')
  await vi.waitFor(() => expect(model.transcribe).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(model.dispose).not.toHaveBeenCalled()
  expect(parent.postMessage).not.toHaveBeenCalledWith({ id: 3, started: true })
  finish({ text: 'Long dictation' })
  await vi.waitFor(() =>
    expect(parent.postMessage).toHaveBeenCalledWith({ id: 3, result: { text: 'Dictation' } }),
  )
  expect(parent.postMessage).toHaveBeenCalledWith({ id: 2, result: { text: 'Long dictation' } })
  expect(model.load).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1000)
  expect(model.dispose).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(model.dispose).toHaveBeenCalledOnce()
  request(4, 'transcribe')
  await vi.waitFor(() => expect(model.load).toHaveBeenCalledTimes(2))
})

it('reports native inference failures and loads a fresh model for a retry', async () => {
  model.transcribe.mockRejectedValueOnce(new Error('Native inference failed'))
  request(1, 'transcribe')
  await vi.waitFor(() =>
    expect(parent.postMessage).toHaveBeenCalledWith({
      id: 1,
      error: 'Error: Native inference failed',
    }),
  )
  expect(model.dispose).toHaveBeenCalledOnce()
  request(2, 'transcribe')
  await vi.waitFor(() =>
    expect(parent.postMessage).toHaveBeenCalledWith({ id: 2, result: { text: 'Dictation' } }),
  )
  expect(model.load).toHaveBeenCalledTimes(2)
})

it.each([true, false])(
  'requests native punctuation only when the existing model supports it (%s)',
  async (supported) => {
    model.supports.mockReturnValue(supported)
    model.transcribe.mockResolvedValue({
      text: 'bonjour Ari.',
      language: 'fr',
      words: [{ text: 'bonjour', t0Ms: 0, t1Ms: 300, unused: 'ignored' }],
    })
    parent.emit('message', {
      data: {
        id: 1,
        kind: 'transcribe',
        path: 'custom.gguf',
        pcm: new Float32Array([0.1]),
        formatText: true,
      },
    })
    await vi.waitFor(() => expect(model.transcribe).toHaveBeenCalledOnce())
    expect(model.transcribe.mock.calls[0]![1]).toEqual(supported ? { pnc: 'on' } : {})
    expect(parent.postMessage).toHaveBeenCalledWith({
      id: 1,
      result: {
        text: 'bonjour Ari.',
        language: 'fr',
        words: [{ text: 'bonjour', t0Ms: 0, t1Ms: 300 }],
      },
    })
  },
)

it('keeps provider defaults and requested language when text formatting is disabled', async () => {
  model.supports.mockReturnValue(true)
  parent.emit('message', {
    data: {
      id: 1,
      kind: 'transcribe',
      path: 'custom.gguf',
      pcm: new Float32Array([0.1]),
      formatText: false,
      language: 'zh',
    },
  })
  await vi.waitFor(() => expect(model.transcribe).toHaveBeenCalledOnce())
  expect(model.transcribe.mock.calls[0]![1]).toEqual({ language: 'zh' })
  expect(model.supports).not.toHaveBeenCalled()
})

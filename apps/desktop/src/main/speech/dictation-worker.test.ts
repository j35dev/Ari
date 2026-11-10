// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  capture: vi.fn(),
  insert: vi.fn(),
  cancel: vi.fn(),
  snapshot: vi.fn(),
}))
vi.mock('./windows-dictation', () => ({
  createWindowsDictation: () => ({ capture: mock.capture }),
}))
let parent: EventEmitter & { postMessage: ReturnType<typeof vi.fn> }

beforeEach(async () => {
  vi.resetModules()
  mock.insert.mockReset().mockResolvedValue(undefined)
  mock.cancel.mockReset()
  mock.snapshot.mockReset().mockReturnValue({ text: 'First sentence.', start: 15, end: 15 })
  mock.capture
    .mockReset()
    .mockReturnValue({ insert: mock.insert, cancel: mock.cancel, snapshot: mock.snapshot })
  parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
  vi.stubGlobal('process', { ...process, parentPort: parent })
  await import('./dictation-worker')
  parent.emit('message', { data: { id: 1, kind: 'capture', target: 'one' } })
})
afterEach(() => vi.unstubAllGlobals())

it('joins finalized speech at a Windows caret and keeps paragraphs and lists intact', async () => {
  const text = 'Please check the logs.\n\n1. Keep useSpeech.\n2. Review the tests.'
  parent.emit('message', { data: { id: 2, kind: 'insert', target: 'one', text } })
  await vi.waitFor(() => expect(mock.insert).toHaveBeenCalledOnce())
  expect(mock.insert.mock.calls[0]![0]).toBe(' ' + text)
  expect(parent.postMessage).toHaveBeenCalledWith({ id: 2, result: undefined })
})

it('does not retry an uncertain native insertion or insert twice for a duplicate completion', async () => {
  mock.insert.mockRejectedValueOnce(new Error('The target changed.'))
  parent.emit('message', { data: { id: 2, kind: 'insert', target: 'one', text: 'dictated' } })
  await vi.waitFor(() =>
    expect(parent.postMessage).toHaveBeenCalledWith({ id: 2, error: 'The target changed.' }),
  )
  parent.emit('message', { data: { id: 3, kind: 'insert', target: 'one', text: 'dictated' } })
  await vi.waitFor(() =>
    expect(parent.postMessage).toHaveBeenCalledWith({
      id: 3,
      error: 'The dictation target is no longer available.',
    }),
  )
  expect(mock.insert).toHaveBeenCalledOnce()
})

it('keeps empty speech empty instead of generating join whitespace', async () => {
  parent.emit('message', { data: { id: 2, kind: 'insert', target: 'one', text: '' } })
  await vi.waitFor(() => expect(mock.insert).toHaveBeenCalledOnce())
  expect(mock.insert.mock.calls[0]![0]).toBe('')
})

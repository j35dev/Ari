import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { dropDraftTextMemory } from './use-drafts'

const mock = vi.hoisted(() => ({
  record: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  invoke: vi.fn(),
}))
vi.mock('../speech/useSpeech', () => ({ useSpeech: () => ({ status: { ready: true } }) }))
vi.mock('../speech/recorder', () => ({ startRecording: mock.record }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mock.invoke, subscribe: () => () => undefined } }))
beforeEach(() => {
  dropDraftTextMemory()
  localStorage.clear()
  mock.record
    .mockReset()
    .mockResolvedValue({ stop: mock.stop, cancel: mock.cancel, level: () => 0 })
  mock.stop.mockReset().mockResolvedValue(new Float32Array([0.1]))
  mock.cancel.mockReset()
  mock.invoke.mockReset().mockResolvedValue({ text: 'dictated' })
})
async function begin() {
  const input = screen.getByLabelText('Message') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'before OLD after' } })
  input.focus()
  input.setSelectionRange(7, 10)
  fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
  await screen.findByRole('button', { name: 'Stop dictation' })
  return input
}
it('dictates into the actual controlled session draft and replaces only its saved selection', async () => {
  const send = vi.fn()
  render(<Composer sessionId="session-one" onSend={send} />)
  const input = await begin()
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(input.value).toBe('before dictated after'))
  expect(input.selectionStart).toBe(15)
  expect(send).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem('ari.drafts') ?? '{}')['session-one']).toBe(
      'before dictated after',
    ),
  )
})
it('keeps a later session and its draft untouched when transcription finishes', async () => {
  let resolve!: (result: { text: string }) => void
  mock.invoke.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const view = render(<Composer sessionId="session-one" onSend={vi.fn()} />)
  await begin()
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(mock.invoke).toHaveBeenCalled())
  view.rerender(<Composer sessionId="session-two" onSend={vi.fn()} />)
  await act(async () => resolve({ text: 'old transcript' }))
  expect(screen.getByLabelText('Message')).toHaveValue('')
})
it('rejects changed selection and explains why the draft was left alone', async () => {
  render(<Composer sessionId="session-one" onSend={vi.fn()} />)
  const input = await begin()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(window, { key: 'Enter' })
  await screen.findByRole('alert')
  expect(input.value).toBe('before OLD after')
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { dropDraftTextMemory } from './use-drafts'
import { finalizeDictation } from '../../../../shared/dictation-format'

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
it('hands the control row to the dictation while it records and takes it back after', async () => {
  const { container } = render(
    <Composer
      sessionId="session-one"
      onSend={vi.fn()}
      leading={<button type="button">pick model</button>}
    />,
  )
  const shell = container.querySelector('.ari-composer-shell') as HTMLElement
  const pickers = screen.getByRole('button', { name: 'pick model' }).parentElement as HTMLElement
  // The user is in the composer, so it is open: the pickers are on show.
  act(() => screen.getByLabelText('Message').focus())
  expect(shell).not.toHaveAttribute('data-dictation')
  expect(pickers).not.toHaveClass('hidden')

  await begin()
  expect(shell).toHaveAttribute('data-dictation', 'recording')
  // "Listening", the meter and the timer take the pickers' place; the pickers
  // stay mounted so an open choice survives the recording.
  expect(pickers).toHaveClass('hidden')
  expect(screen.getByText('Listening')).toBeInTheDocument()
  expect(screen.getByText('0:00')).toBeInTheDocument()
  expect(container.querySelectorAll('.ari-levels i')).toHaveLength(32)
  expect(screen.getByText('Esc to discard')).toBeInTheDocument()
  // The round button finishes the recording, so there is nothing to send with.
  expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(shell).not.toHaveAttribute('data-dictation'))
  expect(pickers).not.toHaveClass('hidden')
  expect(screen.queryByText('Listening')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Dictate a message' })).toBeEnabled()
})
it('says it is transcribing between the last word and the inserted text', async () => {
  let resolve!: (result: { text: string }) => void
  mock.invoke.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const { container } = render(<Composer sessionId="session-one" onSend={vi.fn()} />)
  const shell = container.querySelector('.ari-composer-shell') as HTMLElement
  const input = await begin()
  fireEvent.keyDown(window, { key: 'Enter' })
  expect(await screen.findByText('Transcribing')).toBeInTheDocument()
  expect(shell).toHaveAttribute('data-dictation', 'transcribing')
  expect(screen.queryByText('Esc to discard')).not.toBeInTheDocument()
  await waitFor(() => expect(mock.invoke).toHaveBeenCalled())
  await act(async () => resolve({ text: 'dictated' }))
  await waitFor(() => expect(input.value).toBe('before dictated after'))
  expect(screen.queryByText('Transcribing')).not.toBeInTheDocument()
  expect(shell).not.toHaveAttribute('data-dictation')
})
it('rejects changed selection and explains why the draft was left alone', async () => {
  render(<Composer sessionId="session-one" onSend={vi.fn()} />)
  const input = await begin()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(window, { key: 'Enter' })
  await screen.findByRole('alert')
  expect(input.value).toBe('before OLD after')
})

it('inserts formatted paragraphs into the actual composer, then appends repeated dictation once at the cursor', async () => {
  const send = vi.fn()
  const text = finalizeDictation('i checked the logs. separately we should review the tests')
  mock.invoke.mockResolvedValueOnce({ text }).mockResolvedValueOnce({ text: 'Can you help?' })
  render(<Composer sessionId="formatted-session" onSend={send} />)
  const input = screen.getByLabelText('Message') as HTMLTextAreaElement
  input.focus()
  fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
  await screen.findByRole('button', { name: 'Stop dictation' })
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(input.value).toBe(text))
  expect(input.selectionStart).toBe(text.length)
  fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
  await screen.findByRole('button', { name: 'Stop dictation' })
  fireEvent.keyDown(window, { key: 'Enter' })
  const expected = text + ' Can you help?'
  await waitFor(() => expect(input.value).toBe(expected))
  expect(input.selectionStart).toBe(expected.length)
  expect(input.selectionEnd).toBe(expected.length)
  expect(mock.invoke).toHaveBeenCalledTimes(2)
  expect(send).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem('ari.drafts') ?? '{}')['formatted-session']).toBe(
      expected,
    ),
  )
})

it('preserves manual edits during transcription and keeps the full formatted result for recovery', async () => {
  let finish!: (result: { text: string }) => void
  mock.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  render(<Composer sessionId="session-one" onSend={vi.fn()} />)
  const input = await begin()
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(mock.invoke).toHaveBeenCalled())
  fireEvent.change(input, { target: { value: 'my manual edit' } })
  const text = 'Please keep useSpeech.\n\n1. Check the logs.\n2. Run the tests.'
  await act(async () => finish({ text }))
  expect(input.value).toBe('my manual edit')
  fireEvent.click(screen.getByText('Dictated text kept for review'))
  expect(screen.getByLabelText('Uninserted dictated text')).toHaveValue(text)
  expect(screen.getByRole('alert')).toHaveTextContent('target changed')
})

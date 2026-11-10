import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpeechButton } from './SpeechButton'

const mocks = vi.hoisted(() => ({
  ready: false,
  start: vi.fn(),
  invoke: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('../speech/useSpeech', () => ({ useSpeech: () => ({ status: { ready: mocks.ready } }) }))
vi.mock('../speech/recorder', () => ({ startRecording: mocks.start }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke } }))
beforeEach(() => {
  mocks.ready = false
  mocks.start
    .mockReset()
    .mockResolvedValue({ stop: mocks.stop, cancel: mocks.cancel, level: () => 0.5 })
  mocks.stop.mockReset().mockResolvedValue(new Float32Array([0.1]))
  mocks.cancel.mockReset()
  mocks.invoke.mockReset().mockResolvedValue({ text: 'Dictated text' })
})
afterEach(() => vi.clearAllMocks())
it('disables the mic with the setup tooltip until a model is ready', () => {
  render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert() {} })} />)
  expect(screen.getByRole('button')).toBeDisabled()
  expect(screen.getByTitle('Set up speech to text in Settings')).toBeInTheDocument()
})
it('lets Enter pass through while the mic is idle', () => {
  mocks.ready = true
  render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert() {} })} />)
  const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
})
it('records with a ready model, stops on Enter, and inserts the transcript', async () => {
  mocks.ready = true
  const insert = vi.fn()
  render(
    <SpeechButton
      captureTarget={() => ({
        cancel() {},
        async insert(text) {
          insert(text)
        },
      })}
    />,
  )
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('button', { name: 'Stop dictation' })
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(insert).toHaveBeenCalledWith('Dictated text'))
  expect(mocks.invoke).toHaveBeenCalledWith('speech.transcribe', { pcm: new Float32Array([0.1]) })
})
it('cancels without transcription on unmount', async () => {
  mocks.ready = true
  const view = render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert() {} })} />)
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('button', { name: 'Stop dictation' })
  view.unmount()
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('cancels acquisition on Escape and never inserts a late recording', async () => {
  mocks.ready = true
  let resolve!: (recording: {
    stop: typeof mocks.stop
    cancel: typeof mocks.cancel
    level(): number
  }) => void
  mocks.start.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const insert = vi.fn()
  const cancel = vi.fn()
  render(<SpeechButton captureTarget={() => ({ insert, cancel })} />)
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  fireEvent.keyDown(window, { key: 'Escape' })
  resolve({ stop: mocks.stop, cancel: mocks.cancel, level: () => 0 })
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce())
  expect(cancel).toHaveBeenCalledOnce()
  expect(insert).not.toHaveBeenCalled()
})

it('consumes Enter during transcription and discards the result after focus loss', async () => {
  mocks.ready = true
  let resolve!: (result: { text: string }) => void
  mocks.invoke.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const insert = vi.fn()
  render(<SpeechButton captureTarget={() => ({ insert, cancel() {} })} />)
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('button', { name: 'Stop dictation' })
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
  const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
  window.dispatchEvent(enter)
  expect(enter.defaultPrevented).toBe(true)
  fireEvent.blur(window)
  resolve({ text: 'late result' })
  await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
  expect(insert).not.toHaveBeenCalled()
})

it('does not acquire a microphone when another capture owns the lease', async () => {
  mocks.ready = true
  const previous = window.ari
  const cancel = vi.fn()
  window.ari = {
    invoke: async () => undefined,
    subscribe: () => () => undefined,
    dictation: {
      acquire: async () => {
        throw new Error('Another dictation is active')
      },
      release: async () => undefined,
    },
  }
  try {
    render(<SpeechButton captureTarget={() => ({ cancel, async insert() {} })} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Another dictation')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  } finally {
    window.ari = previous
  }
})

it('discards empty transcription without inserting whitespace', async () => {
  mocks.ready = true
  mocks.invoke.mockResolvedValue({ text: '  \n ' })
  const insert = vi.fn()
  render(<SpeechButton captureTarget={() => ({ insert, cancel() {} })} />)
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('button', { name: 'Stop dictation' })
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
  expect(insert).not.toHaveBeenCalled()
})

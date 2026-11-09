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
  render(<SpeechButton onTranscript={vi.fn()} />)
  expect(screen.getByRole('button')).toBeDisabled()
  expect(screen.getByTitle('Set up speech to text in Settings')).toBeInTheDocument()
})
it('lets Enter pass through while the mic is idle', () => {
  mocks.ready = true
  render(<SpeechButton onTranscript={vi.fn()} />)
  const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
})
it('records with a ready model, stops on Enter, and inserts the transcript', async () => {
  mocks.ready = true
  const insert = vi.fn()
  render(<SpeechButton onTranscript={insert} />)
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('button', { name: 'Stop dictation' })
  fireEvent.keyDown(window, { key: 'Enter' })
  await waitFor(() => expect(insert).toHaveBeenCalledWith('Dictated text'))
  expect(mocks.invoke).toHaveBeenCalledWith('speech.transcribe', { pcm: new Float32Array([0.1]) })
})
it('cancels without transcription on unmount', async () => {
  mocks.ready = true
  const view = render(<SpeechButton onTranscript={vi.fn()} />)
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('button', { name: 'Stop dictation' })
  view.unmount()
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

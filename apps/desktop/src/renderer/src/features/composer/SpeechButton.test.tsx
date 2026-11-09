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

it('keeps long composer dictation active until Enter stops it', async () => {
  mocks.ready = true
  vi.useFakeTimers()
  const insert = vi.fn()
  render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert(text) { insert(text) } })} />)
  await act(async () => fireEvent.click(screen.getByRole('button')))
  act(() => vi.advanceTimersByTime(10 * 60_000))
  expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeEnabled()
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.cancel).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
  await act(async () => fireEvent.keyDown(window, { key: 'Enter' }))
  expect(insert).toHaveBeenCalledWith('Dictated text')
  expect(mocks.stop).toHaveBeenCalledOnce()
})

it('cancels with Escape and discards the recording', async () => {
  mocks.ready = true
  render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert() {} })} />)
  await act(async () => fireEvent.click(screen.getByRole('button')))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.invoke).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Dictate a message' })).toBeEnabled()
})

it('does not start transcription if unmounted while the recording is stopping', async () => {
  mocks.ready = true
  let finishStop!: (pcm: Float32Array) => void
  mocks.stop.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStop = resolve
      }),
  )
  const view = render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert() {} })} />)
  await act(async () => fireEvent.click(screen.getByRole('button')))
  fireEvent.keyDown(window, { key: 'Enter' })
  view.unmount()
  await act(async () => finishStop(new Float32Array([0.1])))
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it.each(['result', 'error'] as const)(
  'ignores a stale transcription %s after disabling and starting a newer recording',
  async (outcome) => {
    mocks.ready = true
    let finish!: (result: { text: string }) => void
    let fail!: (reason: Error) => void
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        }),
    )
    const insert = vi.fn()
    const view = render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert(text) { insert(text) } })} />)
    await act(async () => fireEvent.click(screen.getByRole('button')))
    await act(async () => fireEvent.keyDown(window, { key: 'Enter' }))
    view.rerender(<SpeechButton disabled captureTarget={() => ({ cancel() {}, async insert(text) { insert(text) } })} />)
    view.rerender(<SpeechButton captureTarget={() => ({ cancel() {}, async insert(text) { insert(text) } })} />)
    await act(async () => fireEvent.click(screen.getByRole('button')))
    await act(async () => {
      if (outcome === 'result') finish({ text: 'Old dictation' })
      else fail(new Error('Old transcription failed'))
    })
    expect(insert).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeEnabled()
    await act(async () => fireEvent.keyDown(window, { key: 'Enter' }))
    expect(insert).toHaveBeenCalledWith('Dictated text')
  },
)

it('reports a genuine transcription failure and lets the user retry', async () => {
  mocks.ready = true
  mocks.invoke.mockRejectedValueOnce(new Error('Speech engine stopped'))
  render(<SpeechButton captureTarget={() => ({ cancel() {}, async insert() {} })} />)
  await act(async () => fireEvent.click(screen.getByRole('button')))
  await act(async () => fireEvent.keyDown(window, { key: 'Enter' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Speech engine stopped')
  expect(screen.getByRole('button', { name: 'Dictate a message' })).toBeEnabled()
})

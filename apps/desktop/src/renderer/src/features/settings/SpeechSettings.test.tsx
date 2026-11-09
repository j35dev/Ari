import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpeechSettings } from './SpeechSettings'
import { defaultSettings, MAC_SPEECH_SHORTCUT } from '@ari/contracts/settings'
import type { SpeechModel } from '@ari/contracts/rpc'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  ready: false,
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke } }))
vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: defaultSettings, update: mocks.update }),
}))
vi.mock('../speech/useSpeech', () => ({
  useSpeech: () => ({
    status: { engine: 'missing', model: null, ready: mocks.ready },
    progress: {},
    refresh: mocks.refresh,
  }),
}))
const found: SpeechModel = {
  id: 'found',
  name: 'Found model',
  description: 'Local model',
  filename: 'found.gguf',
  size: 10_000_000,
  languages: ['en'],
  sha256: null,
  repository: null,
  revision: null,
  installed: { path: '/handy/found.gguf', source: 'handy' },
}
const downloadable: SpeechModel = {
  ...found,
  id: 'tiny',
  name: 'Tiny model',
  filename: 'tiny.gguf',
  repository: 'test/tiny',
  revision: 'abc',
  sha256: 'def',
  installed: false,
}
beforeEach(() => {
  mocks.invoke
    .mockReset()
    .mockImplementation((method: string) =>
      Promise.resolve(method === 'speech.models' ? [found, downloadable] : { started: true }),
    )
  mocks.update.mockReset().mockResolvedValue(defaultSettings)
  mocks.refresh.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())
it('offers existing models in place and a separate engine download', async () => {
  render(<SpeechSettings />)
  await screen.findByText('Found model')
  expect(screen.getByRole('button', { name: 'Download engine' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Use model' }))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('speech.select', { modelId: 'found' }),
  )
})
it('downloads the chosen model and saves a lowercase hold-to-talk chord', async () => {
  render(<SpeechSettings />)
  await screen.findByText('Tiny model')
  fireEvent.click(screen.getByRole('button', { name: /^Download$/ }))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('speech.download', { modelId: 'tiny' }),
  )
  fireEvent.keyDown(screen.getByLabelText('Hold-to-talk shortcut'), {
    key: ' ',
    code: 'Space',
    ctrlKey: true,
  })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({ speech: { shortcut: 'ctrl+space' } }),
  )
})

it('shows the saved size with Resume and Discard actions', async () => {
  mocks.invoke.mockImplementation((method: string) =>
    Promise.resolve(
      method === 'speech.models'
        ? [{ ...downloadable, partial: { size: 25_000_000, updatedAt: Date.now() } }]
        : {},
    ),
  )
  render(<SpeechSettings />)
  expect(await screen.findByText('25 MB saved')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('speech.download', { modelId: 'tiny' }),
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('speech.discard', { modelId: 'tiny' }),
  )
})

it('uses the agreed macOS hold-to-talk chord', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  render(<SpeechSettings />)
  expect(screen.getByRole('textbox', { name: 'Hold-to-talk shortcut' })).toHaveValue(
    MAC_SPEECH_SHORTCUT,
  )
})

it('accepts Right Option alone and saves it on release', async () => {
  render(<SpeechSettings />)
  const picker = screen.getByLabelText('Hold-to-talk shortcut')
  fireEvent.keyDown(picker, { key: 'Alt', code: 'AltRight', altKey: true })
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.keyUp(picker, { key: 'Alt', code: 'AltRight' })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({ speech: { shortcut: 'alt-right' } }),
  )
})

it('does not save a modifier alone when it is part of a chord', async () => {
  render(<SpeechSettings />)
  const picker = screen.getByLabelText('Hold-to-talk shortcut')
  fireEvent.keyDown(picker, { key: 'Control', code: 'ControlLeft', ctrlKey: true })
  fireEvent.keyDown(picker, { key: ' ', code: 'Space', ctrlKey: true })
  fireEvent.keyUp(picker, { key: ' ', code: 'Space', ctrlKey: true })
  fireEvent.keyUp(picker, { key: 'Control', code: 'ControlLeft' })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ speech: { shortcut: 'ctrl+space' } }),
  )
})

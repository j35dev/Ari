import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SpeechSettings } from './SpeechSettings'
import { defaultSettings } from '@ari/contracts/settings'
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

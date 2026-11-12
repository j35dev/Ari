import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpeechSettings } from './SpeechSettings'
import { defaultSettings } from '@ari/contracts/settings'
import type { SpeechModel, SpeechStatus, SpeechProgress } from '@ari/contracts/rpc'

const mocks = vi.hoisted(() => ({
  ariaEnabled: true,
  invoke: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  status: { engine: 'missing', engineInstallable: true, model: null, ready: false } as SpeechStatus,
  progress: {} as Record<string, SpeechProgress>,
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke } }))
vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({
    settings: { ...defaultSettings, experimental: { ariaEnabled: mocks.ariaEnabled } },
    update: mocks.update,
  }),
}))
vi.mock('../speech/useSpeech', () => ({
  useSpeech: () => ({
    status: mocks.status,
    progress: mocks.progress,
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
  mocks.ariaEnabled = true
  mocks.status = { engine: 'missing', engineInstallable: true, model: null, ready: false }
  mocks.progress = {}
  mocks.invoke
    .mockReset()
    .mockImplementation((method: string) =>
      Promise.resolve(method === 'speech.models' ? [found, downloadable] : { started: true }),
    )
  mocks.update.mockReset().mockResolvedValue(defaultSettings)
  mocks.refresh.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())
it('keeps general dictation settings when experimental Aria is off', async () => {
  mocks.ariaEnabled = false
  render(<SpeechSettings />)
  await screen.findByText('Found model')
  expect(screen.queryByRole('textbox', { name: 'Aria dictation shortcut' })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Record Aria dictation shortcut' }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'General dictation shortcut' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Record General dictation shortcut' }))
  fireEvent.keyDown(window, { key: 'F20', code: 'F20' })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({ speech: { dictationShortcut: 'f20' } }),
  )
})

it('ends shortcut recording when the Aria experiment is disabled', async () => {
  const view = render(<SpeechSettings />)
  await screen.findByText('Found model')
  fireEvent.click(screen.getByRole('button', { name: 'Record Aria dictation shortcut' }))
  mocks.ariaEnabled = false
  view.rerender(<SpeechSettings />)
  fireEvent.keyDown(window, { key: 'F20', code: 'F20' })
  expect(mocks.update).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Record General dictation shortcut' })).toBeEnabled()
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

it('enables local text formatting by default while spoken commands are opt-in', async () => {
  render(<SpeechSettings />)
  expect(screen.getByRole('switch', { name: 'Format dictated text' })).toBeChecked()
  expect(screen.getByRole('switch', { name: 'Spoken formatting commands' })).not.toBeChecked()
  fireEvent.click(screen.getByRole('switch', { name: 'Format dictated text' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ speech: { formatText: false } }))
  fireEvent.click(screen.getByRole('switch', { name: 'Spoken formatting commands' }))
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({ speech: { spokenFormatting: true } }),
  )
})

it('shows separate Aria and general defaults and edits only the selected binding', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  render(<SpeechSettings />)
  expect(screen.getByRole('textbox', { name: 'Aria dictation shortcut' })).toHaveValue(
    'ctrl+alt+space',
  )
  expect(screen.getByRole('textbox', { name: 'General dictation shortcut' })).toHaveValue(
    'ctrl+alt+d',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Record General dictation shortcut' }))
  fireEvent.keyDown(window, { key: 'F20', code: 'F20' })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({ speech: { dictationShortcut: 'f20' } }),
  )
})

it('rejects the other dictation binding and existing Ari actions', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  render(<SpeechSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Record General dictation shortcut' }))
  fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true, altKey: true })
  expect(screen.getByRole('alert')).toHaveTextContent('different shortcuts')
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })
  expect(screen.getByRole('alert')).toHaveTextContent('already used by Ari')
  expect(mocks.update).not.toHaveBeenCalled()
})

it('keeps the capture lease while recording a binding and releases it on cancellation', async () => {
  const acquire = vi.fn(async () => 'binding-token')
  const release = vi.fn(async () => undefined)
  const previous = window.ari
  window.ari = {
    invoke: async () => undefined,
    subscribe: () => () => undefined,
    dictation: { acquire, release },
  }
  try {
    render(<SpeechSettings />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record General dictation shortcut' }))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Record General dictation shortcut' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(release).toHaveBeenCalledWith('binding-token'))
  } finally {
    window.ari = previous
  }
})
it.each([false, true])(
  'handles a rejected lease release after unmount (pending=%s)',
  async (pending) => {
    let acquired!: (token: string) => void
    const acquire = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          acquired = resolve
        }),
    )
    const release = vi.fn(async () => {
      throw new Error('renderer closed')
    })
    const previous = window.ari
    window.ari = {
      invoke: async () => undefined,
      subscribe: () => () => undefined,
      dictation: { acquire, release },
    }
    try {
      const view = render(<SpeechSettings />)
      fireEvent.click(screen.getByRole('button', { name: 'Record General dictation shortcut' }))
      if (!pending) await act(async () => acquired('binding-token'))
      view.unmount()
      if (pending) await act(async () => acquired('binding-token'))
      await waitFor(() => expect(release).toHaveBeenCalledWith('binding-token'))
    } finally {
      window.ari = previous
    }
  },
)
it.each(['missing', 'ready'] as const)(
  'offers Retry for an engine read error instead of reinstall (%s)',
  async (engine) => {
    mocks.status = {
      engine,
      engineInstallable: false,
      model: null,
      ready: false,
      error:
        "Couldn't read the speech engine files. Close apps that may be using them, then Retry.",
      engineError:
        "Couldn't read the speech engine files. Close apps that may be using them, then Retry.",
    }
    render(<SpeechSettings />)
    expect(screen.queryByRole('button', { name: 'Download engine' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(mocks.invoke).toHaveBeenCalledWith('speech.engine.check')
    expect(screen.queryByRole('button', { name: 'Reinstall engine' })).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalledWith('speech.engine.download')
  },
)
it('offers an explicit reinstall after Retry could not read the engine', async () => {
  mocks.status = {
    engine: 'missing',
    engineError: 'Files still locked',
    engineReinstallable: true,
    engineInstallable: false,
    model: null,
    ready: false,
  }
  render(<SpeechSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Reinstall engine' }))
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('speech.engine.reinstall'))
})
it('waits for completed startup inspection and shows a background model load', () => {
  mocks.status = { engine: 'missing', engineInstallable: false, model: null, ready: false }
  const view = render(<SpeechSettings />)
  expect(screen.getByRole('status')).toHaveTextContent('Checking')
  expect(screen.queryByRole('button', { name: 'Download engine' })).not.toBeInTheDocument()
  mocks.status = {
    engine: 'ready',
    engineInstallable: false,
    model: found,
    loading: true,
    ready: false,
  }
  view.rerender(<SpeechSettings />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
})

it('keeps the engine ready when the active model has a load error', async () => {
  mocks.status = {
    engine: 'ready',
    engineError: null,
    engineInstallable: false,
    model: found,
    ready: false,
    error: 'Invalid GGUF model',
  }
  render(<SpeechSettings />)
  await screen.findByText('Found model')
  expect(screen.getByText('Ready')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Record Aria dictation shortcut' }))
  fireEvent.keyDown(window, {
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
  expect(screen.getByRole('textbox', { name: 'Aria dictation shortcut' })).toHaveValue(
    'shift+meta+space',
  )
})

it('saves the discoverable ducking opt-out on Windows', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  render(<SpeechSettings />)
  fireEvent.click(screen.getByRole('switch', { name: 'Lower other apps while listening' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ speech: { duckAudio: false } }))
  expect(screen.getByText(/25% of their volume/)).toBeInTheDocument()
})

it('explains unsupported macOS output control without enabling it', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  render(<SpeechSettings />)
  expect(screen.getByRole('switch', { name: 'Lower other apps while listening' })).toBeDisabled()
  expect(screen.getByText(/Unavailable on macOS/)).toBeInTheDocument()
})

it('refuses the macOS input-source shortcut and records Cmd+Shift+Space in canonical order', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  render(<SpeechSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Record Aria dictation shortcut' }))
  fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true })
  expect(screen.getByRole('alert')).toHaveTextContent('reserved')
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: ' ', code: 'Space', metaKey: true, shiftKey: true })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      speech: { shortcut: 'shift+meta+space' },
    }),
  )
})

it('requires Record shortcut, saves the next valid key, and stops recording', async () => {
  render(<SpeechSettings />)
  fireEvent.keyDown(window, { key: 'F8', code: 'F8' })
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Record Aria dictation shortcut' }))
  fireEvent.keyDown(window, { key: 'F8', code: 'F8' })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ speech: { shortcut: 'f8' } }),
  )
  fireEvent.keyDown(window, { key: 'F9', code: 'F9' })
  expect(mocks.update).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Record Aria dictation shortcut' })).toBeInTheDocument()
})

it('explains invalid and reserved keys, then accepts another shortcut', async () => {
  render(<SpeechSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Record Aria dictation shortcut' }))
  fireEvent.keyDown(window, { key: 'a', code: 'KeyA' })
  expect(screen.getByRole('alert')).toHaveTextContent('modifier')
  fireEvent.keyDown(window, { key: 'F4', code: 'F4', altKey: true })
  expect(screen.getByRole('alert')).toHaveTextContent('reserved')
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true })
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ speech: { shortcut: 'ctrl+shift+d' } }),
  )
})

it('rejects a modifier alone and allows Esc to cancel without saving', () => {
  render(<SpeechSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Record Aria dictation shortcut' }))
  fireEvent.keyDown(window, { key: 'Alt', code: 'AltRight', altKey: true })
  fireEvent.keyUp(window, { key: 'Alt', code: 'AltRight' })
  expect(screen.getByRole('alert')).toHaveTextContent('modifier')
  fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
  fireEvent.keyDown(window, { key: 'F8', code: 'F8' })
  expect(mocks.update).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Record Aria dictation shortcut' })).toBeInTheDocument()
})

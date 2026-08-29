import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { AdvancedSettings } from './AdvancedSettings'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  holder: { settings: null as Settings | null },
}))

vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: mocks.holder.settings, update: mocks.update }),
}))

const engineSettings: Settings = {
  version: 1,
  appearance: {
    themeId: 'obsidian',
    mode: 'system',
    glass: true,
    reducedMotion: false,
    wallpaper: 'none',
    wallpaperLook: 'balanced',
  },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: ['git status'] },
  window: null,
}

describe('AdvancedSettings', () => {
  let createSpy: MockInstance<(type: string) => HTMLElement>

  function lastAnchor(): HTMLAnchorElement {
    const values: unknown[] = createSpy.mock.results.map((r: { value: unknown }) => r.value)
    const anchor = values.reverse().find((v) => v instanceof HTMLAnchorElement)
    expect(anchor).toBeInstanceOf(HTMLAnchorElement)
    return anchor as HTMLAnchorElement
  }

  beforeEach(() => {
    localStorage.clear()
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    createSpy = vi.spyOn(document, 'createElement')
  })

  it('downloads ari-diagnostics.json via a blob anchor click', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:ari-test')
    const user = userEvent.setup()

    render(<AdvancedSettings />)
    await user.click(screen.getByRole('button', { name: 'Export diagnostics' }))

    const anchor = lastAnchor()
    expect(anchor.download).toBe('ari-diagnostics.json')
    expect(anchor.href).toBe('blob:ari-test')

    const blob = createObjectURL.mock.calls.at(-1)?.[0]
    expect(blob).toBeInstanceOf(Blob)
    const bundle = JSON.parse(await (blob as Blob).text()) as Record<string, string>
    expect(bundle).toEqual({
      appVersion: '0.1.0',
      userAgent: navigator.userAgent,
      appearance: 'obsidian',
    })
  })

  it('downloads the current settings as ari-settings.json', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:ari-settings-test')
    const user = userEvent.setup()

    render(<AdvancedSettings />)
    await user.click(screen.getByRole('button', { name: 'Export settings' }))

    const anchor = lastAnchor()
    expect(anchor.download).toBe('ari-settings.json')
    expect(anchor.href).toBe('blob:ari-settings-test')

    const blob = createObjectURL.mock.calls.at(-1)?.[0]
    expect(await (blob as Blob).text()).toBe(JSON.stringify(engineSettings, null, 2))
  })

  it('imports a bundle by dispatching update with the parsed sections', async () => {
    const user = userEvent.setup()
    render(<AdvancedSettings />)

    const input = screen.getByLabelText('Settings bundle file')
    const bundle = {
      version: 1,
      appearance: { themeId: 'porcelain' },
      permissions: { allowlist: ['git status'] },
      window: { x: 10, y: 20, width: 800, height: 600, maximized: false },
    }
    await user.upload(
      input,
      new File([JSON.stringify(bundle)], 'bundle.json', { type: 'application/json' }),
    )

    // Device-local window bounds are never imported.
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        appearance: { themeId: 'porcelain' },
        permissions: { allowlist: ['git status'] },
      }),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('surfaces an error and skips update for invalid bundles', async () => {
    const user = userEvent.setup()
    render(<AdvancedSettings />)

    const input = screen.getByLabelText('Settings bundle file')
    await user.upload(
      input,
      new File(['{"version":2,"appearance":{}}'], 'bundle.json', { type: 'application/json' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import failed: unsupported settings version: 2',
    )
    expect(mocks.update).not.toHaveBeenCalled()

    await user.upload(input, new File(['{not json'], 'bundle.json', { type: 'application/json' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import failed: file is not valid JSON',
    )
  })

  it('explains that session journals live under userData/sessions', () => {
    render(<AdvancedSettings />)
    expect(screen.getByText('userData/sessions')).toBeInTheDocument()
  })

  it('clears ari.drafts.* keys only after inline confirm', async () => {
    localStorage.setItem('ari.drafts.session-1', 'hello')
    localStorage.setItem('ari.drafts.session-2', 'world')
    localStorage.setItem('ari.allowlist', '[]')
    const user = userEvent.setup()
    render(<AdvancedSettings />)

    await user.click(screen.getByRole('button', { name: 'Clear cached drafts' }))
    expect(localStorage.getItem('ari.drafts.session-1')).toBe('hello')

    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(localStorage.getItem('ari.drafts.session-1')).toBeNull()
    expect(localStorage.getItem('ari.drafts.session-2')).toBeNull()
    expect(localStorage.getItem('ari.allowlist')).toBe('[]')
    expect(screen.getByText('Cleared 2 cached drafts.')).toBeInTheDocument()
  })

  it('cancel keeps drafts intact', async () => {
    localStorage.setItem('ari.drafts.session-1', 'hello')
    const user = userEvent.setup()
    render(<AdvancedSettings />)

    await user.click(screen.getByRole('button', { name: 'Clear cached drafts' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(localStorage.getItem('ari.drafts.session-1')).toBe('hello')
  })
})

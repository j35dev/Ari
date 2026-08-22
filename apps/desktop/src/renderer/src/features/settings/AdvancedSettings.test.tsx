import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as ThemeProviderModule from '@ari/ui/theme-provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdvancedSettings } from './AdvancedSettings'

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }))

vi.mock('@ari/ui/theme-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof ThemeProviderModule>()),
  useTheme: () => ({ theme: 'ember', setTheme }),
}))

describe('AdvancedSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('downloads ari-diagnostics.json via a blob anchor click', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:ari-test')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    const createSpy = vi.spyOn(document, 'createElement')

    render(<AdvancedSettings />)
    await user.click(screen.getByRole('button', { name: 'Export diagnostics' }))

    expect(createSpy).toHaveBeenCalledWith('a')
    const anchor = createSpy.mock.results
      .map((r) => r.value as unknown)
      .find((v) => v instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('ari-diagnostics.json')
    expect(anchor.href).toBe('blob:ari-test')
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ari-test')

    const blob = createObjectURL.mock.calls[0]?.[0]
    expect(blob).toBeInstanceOf(Blob)
    const bundle = JSON.parse(await (blob as Blob).text()) as Record<string, string>
    expect(bundle).toEqual({
      appVersion: '0.1.0',
      userAgent: navigator.userAgent,
      theme: 'ember',
    })
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

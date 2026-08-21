import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { THEMES } from '@ari/ui/theme-provider'
import type * as ThemeProviderModule from '@ari/ui/theme-provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }))

vi.mock('@ari/ui/theme-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof ThemeProviderModule>()),
  useTheme: () => ({ theme: 'obsidian', setTheme }),
}))

describe('AppearanceSettings', () => {
  beforeEach(() => {
    setTheme.mockClear()
    localStorage.clear()
  })

  it('renders one preview card per theme', () => {
    render(<AppearanceSettings />)
    for (const t of THEMES) {
      expect(screen.getByRole('button', { name: t.label })).toBeInTheDocument()
    }
  })

  it('calls setTheme with the picked theme id', async () => {
    const user = userEvent.setup()
    render(<AppearanceSettings />)
    await user.click(screen.getByRole('button', { name: 'Ember' }))
    expect(setTheme).toHaveBeenCalledOnce()
    expect(setTheme).toHaveBeenCalledWith('ember')
  })

  it('persists the reduced-motion toggle to localStorage', async () => {
    const user = userEvent.setup()
    render(<AppearanceSettings />)
    expect(localStorage.getItem('ari.reducedMotion')).toBeNull()
    await user.click(screen.getByRole('switch', { name: 'Reduce motion' }))
    expect(localStorage.getItem('ari.reducedMotion')).toBe('true')
  })
})

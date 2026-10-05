// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { oklchToHex } from '@ari/ui/color'
import { themeList, themes } from '@ari/ui/themes'
import { ThemeChrome } from '../lib/theme-chrome'
import { ThemePicker } from './ThemePicker'

beforeEach(() => {
  localStorage.clear()
  document.head.innerHTML = '<meta name="theme-color" content="#000000" />'
})
afterEach(cleanup)

function picker(): void {
  render(
    <ThemeProvider>
      <ThemeChrome />
      <ThemePicker />
    </ThemeProvider>,
  )
}

describe('choosing a theme on the phone', () => {
  it('offers the system setting and every Ari theme', () => {
    picker()
    // Read from the registry, so a theme added on the desktop reaches the phone
    // without this list going stale.
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'System',
      ...themeList.map((theme) => theme.label),
    ])
    expect(themeList.length).toBeGreaterThanOrEqual(6)
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')
  })

  it('paints the theme the user picks and marks only that one', () => {
    picker()
    fireEvent.click(screen.getByRole('radio', { name: 'Graphite' }))
    expect(document.documentElement.dataset['ariTheme']).toBe('graphite')
    expect(
      screen
        .getAllByRole('radio')
        .filter((radio) => radio.getAttribute('aria-checked') === 'true')
        .map((radio) => radio.getAttribute('aria-label')),
    ).toEqual(['Graphite'])
  })

  it('previews each theme in its own colours', () => {
    picker()
    expect(
      screen.getByRole('radio', { name: 'Sandstone' }).querySelector('[data-ari-theme]'),
    ).toHaveProperty('dataset.ariTheme', 'sandstone')
  })

  it('makes the browser chrome follow the theme background', () => {
    picker()
    fireEvent.click(screen.getByRole('radio', { name: 'Porcelain' }))
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      oklchToHex(themes.porcelain.colors.bg),
    )
  })
})

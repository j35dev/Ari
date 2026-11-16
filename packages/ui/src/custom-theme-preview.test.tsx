import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { neonThemeExample, type CustomTheme } from '@ari/contracts/themes'
import { ThemeProvider, useTheme, applyCachedTheme, type ThemePersistence } from './theme-provider'
import { paintCustomTheme } from './custom-themes'

function Probe() {
  const { mode, theme, customThemes, previewTheme, adoptLibrary } = useTheme()
  return (
    <>
      <output data-testid="state">{`${mode}|${theme.label}|${customThemes.length}`}</output>
      <button onClick={() => previewTheme(neonThemeExample.id)}>Preview neon</button>
      <button
        onClick={() =>
          adoptLibrary({
            themes: [{ ...neonThemeExample, name: 'Revision two' }],
            previewId: neonThemeExample.id,
          })
        }
      >
        Revise
      </button>
    </>
  )
}
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'ari.theme',
    JSON.stringify({ mode: 'obsidian', wallpaper: 'none', customThemes: [neonThemeExample] }),
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  paintCustomTheme(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('never persists a preview and reverts automatically after 30 seconds', async () => {
  const persistence: ThemePersistence = {
    load: vi.fn(async () => ({ mode: 'obsidian', customThemes: [neonThemeExample] })),
    save: vi.fn(async () => {}),
  }
  render(
    <ThemeProvider persistence={persistence}>
      <Probe />
    </ThemeProvider>,
  )
  await waitFor(() => expect(persistence.save).toHaveBeenCalled())
  vi.useFakeTimers()
  fireEvent.click(screen.getByText('Preview neon'))
  expect(screen.getByText('Keep theme')).toBeInTheDocument()
  expect(screen.getByTestId('state')).toHaveTextContent('obsidian|Neon circuit|1')
  await act(() => vi.advanceTimersByTime(30_000))
  expect(screen.queryByText('Keep theme')).not.toBeInTheDocument()
  expect(screen.getByTestId('state')).toHaveTextContent('obsidian|Obsidian|1')
  expect(vi.mocked(persistence.save).mock.calls.every(([prefs]) => prefs.mode === 'obsidian')).toBe(
    true,
  )
})
it('retains the confirmed revision when a replacement preview is cancelled', () => {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  )
  fireEvent.click(screen.getByText('Preview neon'))
  fireEvent.click(screen.getByText('Keep theme'))
  expect(screen.getByTestId('state')).toHaveTextContent('custom:neon|Neon circuit')
  fireEvent.click(screen.getByText('Revise'))
  expect(screen.getByTestId('state')).toHaveTextContent('custom:neon|Revision two')
  fireEvent.click(screen.getByText('Revert'))
  expect(screen.getByTestId('state')).toHaveTextContent('custom:neon|Neon circuit')
  const prefs = JSON.parse(localStorage.getItem('ari.theme')!) as {
    activeCustomTheme: CustomTheme
    customThemes: CustomTheme[]
  }
  expect(prefs.activeCustomTheme.name).toBe('Neon circuit')
  expect(prefs.customThemes[0]?.name).toBe('Revision two')
  applyCachedTheme()
  expect(document.documentElement.dataset['ariCustomTheme']).toBe('custom:neon')
})
it('has a keyboard escape to the default even from a confirmed custom theme', () => {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  )
  fireEvent.click(screen.getByText('Preview neon'))
  fireEvent.click(screen.getByText('Keep theme'))
  fireEvent.keyDown(window, { code: 'KeyT', ctrlKey: true, altKey: true, shiftKey: true })
  expect(screen.getByTestId('state')).toHaveTextContent('obsidian|Obsidian')
  expect(document.documentElement.dataset['ariCustomTheme']).toBeUndefined()
})
it('reports a failed preference save without removing the recovery path', async () => {
  const persistence: ThemePersistence = {
    load: async () => ({ mode: 'obsidian', customThemes: [neonThemeExample] }),
    save: vi.fn(async () => {
      throw new Error('Disk full')
    }),
  }
  render(
    <ThemeProvider persistence={persistence}>
      <Probe />
    </ThemeProvider>,
  )
  await screen.findByText(/Could not save the theme choice/)
  expect(screen.getByText('Reset theme')).toBeInTheDocument()
})

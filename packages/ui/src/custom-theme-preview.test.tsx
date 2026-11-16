import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
/** The recovery bar sits in a shadow root, out of reach of `screen` and of theme CSS. */
function recovery() {
  const root = document.querySelector('[data-ari-shield]')?.shadowRoot
  return root ? within(root as unknown as HTMLElement) : null
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
  expect(recovery()!.getByText('Keep theme')).toBeInTheDocument()
  expect(screen.getByTestId('state')).toHaveTextContent('obsidian|Neon circuit|1')
  await act(() => vi.advanceTimersByTime(30_000))
  expect(recovery()).toBeNull()
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
  fireEvent.click(recovery()!.getByText('Keep theme'))
  expect(screen.getByTestId('state')).toHaveTextContent('custom:neon|Neon circuit')
  fireEvent.click(screen.getByText('Revise'))
  expect(screen.getByTestId('state')).toHaveTextContent('custom:neon|Revision two')
  fireEvent.click(recovery()!.getByText('Revert'))
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
  fireEvent.click(recovery()!.getByText('Keep theme'))
  expect(recovery()).toBeNull()
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
  await waitFor(() => expect(recovery()?.getByText(/Could not save the theme choice/)).toBeTruthy())
  expect(recovery()!.getByText('Reset theme')).toBeInTheDocument()
})

// Review of #543: a previewed theme made the bar invisible and stretched "Keep theme"
// over the window, so the next click anywhere kept the theme.
it('keeps the recovery bar out of reach of theme CSS', () => {
  const attack =
    '[data-ari-theme-recovery]{opacity:0!important} [data-ari-theme-recovery] button:first-of-type{position:fixed!important;inset:0!important}' +
    ' button{order:9!important;font-size:0!important} button::after{content:"Revert"!important}'
  const style = document.createElement('style')
  style.textContent = attack
  document.head.append(style)
  try {
    localStorage.setItem(
      'ari.theme',
      JSON.stringify({
        mode: 'obsidian',
        wallpaper: 'none',
        customThemes: [{ ...neonThemeExample, css: attack }],
      }),
    )
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByText('Preview neon'))
    // jsdom applies document sheets inside shadow trees, so computed styles prove
    // nothing here; Chromium does not. What is checked is that no theme selector can
    // reach the bar, nothing inherits through its host, and its labels stand.
    expect(document.querySelectorAll('[data-ari-theme-recovery], button:first-of-type')).toSatisfy(
      (found: NodeListOf<Element>) =>
        Array.from(found).every(
          (element) => element.tagName !== 'BUTTON' || !element.closest('aside'),
        ),
    )
    expect(document.querySelector('[data-ari-theme-recovery]')).toBeNull()
    const host = document.querySelector<HTMLElement>('[data-ari-shield]')!
    expect(host.getAttribute('style')).toContain('all:initial !important')
    expect(host.getAttribute('style')).toContain('direction:ltr !important')
    const sheet = host.shadowRoot!.querySelector('style')!.textContent
    expect(sheet).toContain(':host::after{content:none !important')
    expect(sheet).not.toMatch(/var\(/)
    const bar = host.shadowRoot!.querySelector('[data-ari-theme-recovery]')!
    expect(bar.getAttribute('popover')).toBe('manual')
    expect(Array.from(bar.querySelectorAll('button'), (button) => button.textContent)).toEqual([
      'Keep theme',
      'Revert',
      'Reset theme',
    ])
  } finally {
    style.remove()
  }
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from './theme-provider'
import type { ThemePersistence } from './theme-provider'

/** Media-query stub: every listed query matches, everything else does not. */
function stubMatchMedia(matching: string[]): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matching.some((m) => query.includes(m)),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  )
}

function Probe() {
  const { themeId, mode, resolvedScheme, glassEnabled, setTheme, setMode, setGlass } = useTheme()
  return (
    <div>
      <output data-testid="state">{`${themeId}|${mode}|${resolvedScheme}|${glassEnabled}`}</output>
      <button onClick={() => setTheme('porcelain')}>light</button>
      <button onClick={() => setTheme('nocturne')}>nocturne</button>
      <button onClick={() => setMode('system')}>system</button>
      <button onClick={() => setGlass(false)}>glass off</button>
    </div>
  )
}

const root = () => document.documentElement.dataset

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    stubMatchMedia(['prefers-color-scheme: dark'])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows the system scheme by default and applies html attributes', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
    expect(root()['ariScheme']).toBe('dark')
    expect(root()['ariGlass']).toBe('on')
    expect(screen.getByTestId('state')).toHaveTextContent('obsidian|system|dark|true')
  })

  it('picks the light theme when the OS prefers light', async () => {
    stubMatchMedia([])
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('porcelain'))
    expect(root()['ariScheme']).toBe('light')
    // Porcelain is opaque, so glass is off even though the user opted in.
    expect(root()['ariGlass']).toBe('off')
  })

  it('swaps both attributes when a theme is pinned', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('light'))
    await waitFor(() => expect(root()['ariTheme']).toBe('porcelain'))
    expect(root()['ariScheme']).toBe('light')
    expect(screen.getByTestId('state')).toHaveTextContent('porcelain|porcelain|light|false')

    await user.click(screen.getByText('system'))
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
  })

  it('honors the glass opt-out on a glass-capable theme', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('nocturne'))
    await waitFor(() => expect(root()['ariGlass']).toBe('on'))
    await user.click(screen.getByText('glass off'))
    await waitFor(() => expect(root()['ariGlass']).toBe('off'))
  })

  it('forces glass off under prefers-reduced-transparency', async () => {
    stubMatchMedia(['prefers-color-scheme: dark', 'prefers-reduced-transparency'])
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
    expect(root()['ariGlass']).toBe('off')
    expect(screen.getByTestId('state')).toHaveTextContent('obsidian|system|dark|false')
  })

  it('round-trips preferences through the injected persistence', async () => {
    const saved: unknown[] = []
    const persistence: ThemePersistence = {
      load: () => Promise.resolve({ mode: 'verdant', glass: false }),
      save: (prefs) => {
        saved.push(prefs)
        return Promise.resolve()
      },
    }
    render(
      <ThemeProvider persistence={persistence}>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('verdant'))
    await waitFor(() =>
      expect(saved).toContainEqual({ mode: 'verdant', glass: false, themeId: 'verdant' }),
    )
    // localStorage keeps a pre-hydration cache so the next boot paints instantly.
    expect(localStorage.getItem('ari.theme')).toContain('verdant')
  })

  it('throws when useTheme is called outside the provider', () => {
    expect(() => render(<Probe />)).toThrow(/within ThemeProvider/)
  })
})

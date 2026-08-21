import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export const THEMES = [
  { id: 'obsidian', label: 'Obsidian', appearance: 'dark' },
  { id: 'graphite', label: 'Graphite', appearance: 'dark' },
  { id: 'porcelain', label: 'Porcelain', appearance: 'light' },
  { id: 'ember', label: 'Ember', appearance: 'dark' },
  { id: 'verdant', label: 'Verdant', appearance: 'dark' },
  { id: 'ultraviolet', label: 'Ultraviolet', appearance: 'dark' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

const STORAGE_KEY = 'ari.theme'

interface ThemeContextValue {
  theme: ThemeId
  setTheme(theme: ThemeId): void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && THEMES.some((t) => t.id === raw)) return raw as ThemeId
  } catch {
    // storage unavailable (e.g. file:// restrictions) — fall through to default
  }
  return 'obsidian'
}

/**
 * Applies the active theme via `data-theme` on <html> and persists the
 * choice. Persistence moves to the engine settings store in M12; localStorage
 * is the boot-time stub so themes work before the engine exists.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme)

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // non-fatal: theme simply won't persist
    }
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme: setThemeState }), [theme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

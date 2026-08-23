import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Ari ships a single designed appearance: comet-style dark glass. The provider
 * remains as the mount point that applies `data-ari` to <html> (glass.css and
 * platform fallbacks key off it) so components have one stable hook.
 */
export const APPEARANCE = 'comet-glass'

const STORAGE_KEY = 'ari.appearance'

interface AppearanceContextValue {
  /** Identifier of the active appearance; constant until themes return. */
  appearance: typeof APPEARANCE
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null)

function readStoredAppearance(): typeof APPEARANCE {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === APPEARANCE) return APPEARANCE
  } catch {
    // storage unavailable (e.g. file:// restrictions) — fall through to default
  }
  return APPEARANCE
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance] = useState<typeof APPEARANCE>(readStoredAppearance)

  useEffect(() => {
    document.documentElement.dataset['ari'] = appearance
    try {
      localStorage.setItem(STORAGE_KEY, appearance)
    } catch {
      // non-fatal: appearance simply won't persist
    }
  }, [appearance])

  const value = useMemo(() => ({ appearance }), [appearance])
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

export function useTheme(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

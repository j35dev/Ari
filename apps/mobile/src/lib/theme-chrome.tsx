import { useEffect, type ReactNode } from 'react'
import { oklchToHex } from '@ari/ui/color'
import { useTheme } from '@ari/ui/theme-provider'

/** Keeps the browser's own chrome, and Android's status bar, the colour of the app behind it. */
export function ThemeChrome(): ReactNode {
  const { theme } = useTheme()
  useEffect(() => {
    const color = oklchToHex(theme.colors.bg)
    if (color !== null)
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  }, [theme])
  return null
}

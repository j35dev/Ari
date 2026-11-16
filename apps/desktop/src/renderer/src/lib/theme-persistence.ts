import type { ThemePersistence } from '@ari/ui/theme-provider'
import { themeLibraryEventSchema } from '@ari/contracts/themes'
import { createLogger } from '@ari/shared/logger'
import { rpc } from './rpc'

const log = createLogger('renderer:theme')

/**
 * Durable storage for theme preferences: the engine settings store, reached
 * over RPC. `theme.apply` follows every save so the native chrome (Windows
 * overlay symbols, OS light/dark hint) tracks the palette immediately.
 */
export const themePersistence: ThemePersistence = {
  async load() {
    const settings = await rpc.invoke('settings.get')
    const { themeId, mode, wallpaper, customThemes, activeCustomTheme } = settings.appearance
    return { themeId, mode, wallpaper, customThemes, activeCustomTheme }
  },
  async save({ themeId, mode, wallpaper, activeCustomTheme }) {
    await rpc.invoke('settings.update', {
      appearance: { themeId, mode, wallpaper, activeCustomTheme },
    })
  },
  async paint(themeId, customTheme) {
    await rpc.invoke('theme.apply', { themeId, customTheme }).catch((error: unknown) => {
      log.warn('theme.apply failed; native chrome may lag', { error })
      return { applied: false }
    })
  },
  subscribe(listener) {
    return rpc.subscribe('themes.changed', {}, (payload) => {
      const event = themeLibraryEventSchema.safeParse(payload)
      if (event.success) listener(event.data)
    })
  },
}

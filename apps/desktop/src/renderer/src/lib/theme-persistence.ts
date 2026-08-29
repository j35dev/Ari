import type { ThemePersistence } from '@ari/ui/theme-provider'
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
    const { themeId, mode, glass, wallpaper } = settings.appearance
    return { themeId, mode, glass, wallpaper }
  },
  async save({ themeId, mode, glass, wallpaper }) {
    await rpc.invoke('settings.update', { appearance: { themeId, mode, glass, wallpaper } })
    await rpc.invoke('theme.apply', { themeId }).catch((error: unknown) => {
      log.warn('theme.apply failed; native chrome may lag', { error })
      return { applied: false }
    })
  },
}

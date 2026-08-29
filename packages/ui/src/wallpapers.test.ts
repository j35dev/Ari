import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isWallpaperId,
  isWallpaperLook,
  isWallpaperSetting,
  wallpaperIds,
  wallpaperLooks,
  wallpapers,
} from './wallpapers'

/** Disk size ceiling for a bundled scene — keeps the installer lean. */
const WALLPAPER_BUDGET_BYTES = 1_500_000

describe('wallpaper registry', () => {
  it('has unique ids with labels and asset urls', () => {
    expect(wallpapers.map((w) => w.id)).toEqual([...wallpaperIds])
    for (const wallpaper of wallpapers) {
      expect(wallpaper.label.length).toBeGreaterThan(0)
      expect(wallpaper.description.length).toBeGreaterThan(0)
      expect(wallpaper.src).toBeTruthy()
    }
  })

  it('ships every scene as a real file within the bundle budget', () => {
    for (const wallpaper of wallpapers) {
      // vitest runs from the package dir, so the vendored asset sits at src/.
      const file = resolve(process.cwd(), 'src/assets/wallpapers', `${wallpaper.id}.jpg`)
      expect(existsSync(file), wallpaper.id).toBe(true)
      expect(statSync(file).size, wallpaper.id).toBeLessThan(WALLPAPER_BUDGET_BYTES)
    }
  })

  it('guards unknown ids at the persistence boundary', () => {
    expect(isWallpaperId('anime-city')).toBe(true)
    expect(isWallpaperId('aurora')).toBe(false)
    expect(isWallpaperSetting('none')).toBe(true)
    expect(isWallpaperSetting('moon-landscape')).toBe(true)
    expect(isWallpaperSetting(42)).toBe(false)
    expect(isWallpaperSetting(undefined)).toBe(false)
  })

  it('offers exactly the three visibility looks the CSS implements', () => {
    expect(wallpaperLooks.map((look) => look.id)).toEqual(['subtle', 'balanced', 'vivid'])
    for (const look of wallpaperLooks) {
      expect(look.label.length).toBeGreaterThan(0)
      expect(look.scrim).toMatch(/^--wallpaper-scrim-/)
    }
    expect(isWallpaperLook('balanced')).toBe(true)
    expect(isWallpaperLook('extreme')).toBe(false)
  })
})

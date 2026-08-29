/**
 * Ari's bundled wallpaper registry — the background scenes that can be
 * composited under the themed UI. Parallel to `themes.ts`: this module owns
 * the ids/labels/asset URLs, contracts keeps a duplicate literal id list so
 * the engine never depends on the React UI package, and a cross-package test
 * in apps/desktop pins the two in sync.
 *
 * Assets are imported so Vite emits (and hashes) them into the renderer
 * bundle; `wallpaper.css` references the same files for the paint side.
 */

import animeCity from './assets/wallpapers/anime-city.jpg'
import moonLandscape from './assets/wallpapers/moon-landscape.jpg'
import moonLandscape2 from './assets/wallpapers/moon-landscape-2.jpg'

export const wallpaperIds = ['anime-city', 'moon-landscape', 'moon-landscape-2'] as const
export type WallpaperId = (typeof wallpaperIds)[number]

/** A wallpaper preference: a bundled scene, or 'none' for the plain theme. */
export type WallpaperSetting = 'none' | WallpaperId

export interface Wallpaper {
  id: WallpaperId
  label: string
  /** One-line description shown under the label in the picker. */
  description: string
  /** Resolved asset URL for thumbnails and the composited layer. */
  src: string
}

/** Picker order; ids must match `wallpaperIdSchema` in @ari/contracts. */
export const wallpapers: readonly Wallpaper[] = [
  {
    id: 'anime-city',
    label: 'Anime City',
    description: 'Illustrated neon cityscape.',
    src: animeCity,
  },
  {
    id: 'moon-landscape',
    label: 'Moon Landscape',
    description: 'Moonlit night scene.',
    src: moonLandscape,
  },
  {
    id: 'moon-landscape-2',
    label: 'Moon Landscape II',
    description: 'Moonlit night scene, alternate frame.',
    src: moonLandscape2,
  },
]

export function isWallpaperId(value: unknown): value is WallpaperId {
  return typeof value === 'string' && (wallpaperIds as readonly string[]).includes(value)
}

export function isWallpaperSetting(value: unknown): value is WallpaperSetting {
  return value === 'none' || isWallpaperId(value)
}

/**
 * How strongly the scene shows through, per `wallpaperLookSchema` in
 * @ari/contracts. The values are the CSS custom properties wallpaper.css
 * derives each look from; labels/descriptions feed the picker control.
 */
export const wallpaperLooks = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Mildly frosted; scene clearly visible behind glass.',
    scrim: '--wallpaper-scrim-balanced',
  },
  {
    id: 'vivid',
    label: 'Vivid',
    description: 'Crisp image; the main pane wears the sidebar’s glass.',
    scrim: '--wallpaper-scrim-vivid',
  },
] as const

export type WallpaperLookId = (typeof wallpaperLooks)[number]['id']

export function isWallpaperLook(value: unknown): value is WallpaperLookId {
  return typeof value === 'string' && wallpaperLooks.some((look) => look.id === value)
}


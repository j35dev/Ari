import { z } from 'zod'
import { driverKindSchema, permissionModeSchema } from './common'

/**
 * Theme identifiers. Mirrors `themeIds` in packages/ui/src/themes.ts, which
 * owns the palettes; contracts keeps its own literal list so the engine never
 * depends on the React UI package.
 */
export const themeIdSchema = z.enum([
  'obsidian',
  'graphite',
  'nocturne',
  'verdant',
  'porcelain',
  'sandstone',
])
export type ThemeIdSetting = z.infer<typeof themeIdSchema>

/** Either an explicit theme or 'system' (follow the OS color scheme). */
export const themeModeSchema = z.union([z.literal('system'), themeIdSchema])
export type ThemeMode = z.infer<typeof themeModeSchema>

/** Bundled wallpaper identifiers (the paintable scenes; 'none' handled below). */
export const wallpaperIdSchema = z.enum(['anime-city', 'moon-landscape', 'moon-landscape-2'])
export type WallpaperIdSetting = z.infer<typeof wallpaperIdSchema>

/** A wallpaper selection: a bundled scene, or 'none' for the plain theme. */
export const wallpaperSchema = z.union([z.literal('none'), wallpaperIdSchema])
export type WallpaperSetting = z.infer<typeof wallpaperSchema>

const defaultAppearance = {
  themeId: 'obsidian',
  mode: 'system',
  glass: true,
  reducedMotion: false,
  wallpaper: 'none',
} as const

/** Persisted application settings. Versioned for forward migration. */
export const settingsSchema = z.object({
  version: z.literal(1),
  appearance: z
    .object({
      /** Theme resolved and applied on last run; the paint source before boot. */
      themeId: z.preprocess(
        // Pre-M16 files stored 'comet-glass'; map anything unknown to the default.
        (v) => (themeIdSchema.safeParse(v).success ? v : defaultAppearance.themeId),
        themeIdSchema,
      ).default(defaultAppearance.themeId),
      /** User's selection: 'system' tracks the OS, otherwise a pinned theme. */
      mode: themeModeSchema.default(defaultAppearance.mode),
      /** Opt-in translucent chrome; only honored by glass-capable themes. */
      glass: z.boolean().default(defaultAppearance.glass),
      reducedMotion: z.boolean().default(defaultAppearance.reducedMotion),
      /** Bundled background scene composited under the themed UI, or 'none'. */
      wallpaper: wallpaperSchema.default(defaultAppearance.wallpaper),
    })
    .default(defaultAppearance),
  sessions: z
    .object({
      defaultDriverKind: driverKindSchema.nullable().default(null),
      defaultPermissionMode: permissionModeSchema.default('ask'),
    })
    .default({ defaultDriverKind: null, defaultPermissionMode: 'ask' }),
  notifications: z
    .object({
      /** Soft chime when a turn settles; failures get their own muted tone. */
      settleSound: z.boolean().default(true),
    })
    .default({ settleSound: true }),
  permissions: z
    .object({
      /** Tools pre-approved across all sessions, e.g. ['Bash(git status*)']. */
      allowlist: z.array(z.string()).default([]),
    })
    .default({ allowlist: [] }),
  window: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      maximized: z.boolean().default(false),
    })
    .nullable()
    .default(null),
})
export type Settings = z.infer<typeof settingsSchema>

/**
 * Shallow per-section patch accepted by `settings.update`. Sections are
 * optional; fields inside a provided section are optional and merged onto the
 * stored settings by the engine. Fields are deliberately default-free so the
 * parsed patch only carries keys the caller actually sent.
 */
export const settingsUpdateSchema = z.object({
  appearance: z
    .object({
      themeId: themeIdSchema,
      mode: themeModeSchema,
      glass: z.boolean(),
      reducedMotion: z.boolean(),
      wallpaper: wallpaperSchema,
    })
    .partial()
    .optional(),
  sessions: z
    .object({
      defaultDriverKind: driverKindSchema.nullable(),
      defaultPermissionMode: permissionModeSchema,
    })
    .partial()
    .optional(),
  notifications: z
    .object({
      settleSound: z.boolean(),
    })
    .partial()
    .optional(),
  permissions: z
    .object({
      allowlist: z.array(z.string()),
    })
    .partial()
    .optional(),
  window: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      maximized: z.boolean(),
    })
    .nullable()
    .optional(),
})
export type SettingsUpdate = z.input<typeof settingsUpdateSchema>

export const defaultSettings: Settings = {
  version: 1,
  appearance: { ...defaultAppearance },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  notifications: { settleSound: true },
  permissions: { allowlist: [] },
  window: null,
}

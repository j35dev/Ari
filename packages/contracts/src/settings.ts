import { z } from 'zod'
import { delegationSettingsSchema } from './agent-control'
import { driverKindSchema, permissionModeSchema } from './common'
import { remoteOriginSchema } from './remote'

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
  reducedMotion: false,
  wallpaper: 'none',
} as const

/** Persisted application settings. Versioned for forward migration. */
export const settingsSchema = z.object({
  delegation: delegationSettingsSchema.default(() => delegationSettingsSchema.parse({})),
  version: z.literal(1),
  appearance: z
    .object({
      /** Theme resolved and applied on last run; the paint source before boot. */
      themeId: z
        .preprocess(
          // Pre-M16 files stored 'comet-glass'; map anything unknown to the default.
          (v) => (themeIdSchema.safeParse(v).success ? v : defaultAppearance.themeId),
          themeIdSchema,
        )
        .default(defaultAppearance.themeId),
      /** User's selection: 'system' tracks the OS, otherwise a pinned theme. */
      mode: themeModeSchema.default(defaultAppearance.mode),
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
  /**
   * Remote access (ADR §5). The gateway listens on loopback and is off until
   * the user turns it on; `allowedOrigins` names the exact extra origins a
   * client may call from, which the managed PWA needs and a phone on the
   * tailnet does not (that one is served by the gateway itself).
   */
  remote: z
    .object({
      enabled: z.boolean().default(false),
      /** Loopback port for the gateway. 0 lets the OS pick a free one. */
      port: z.number().int().min(0).max(65535).default(8787),
      /** Exact origins, e.g. 'https://connect.example.com'. Never a pattern. */
      allowedOrigins: z.array(remoteOriginSchema).default([]),
    })
    .default({ enabled: false, port: 8787, allowedOrigins: [] }),
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
  delegation: delegationSettingsSchema.partial().optional(),
  appearance: z
    .object({
      themeId: themeIdSchema,
      mode: themeModeSchema,
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
  remote: z
    .object({
      enabled: z.boolean(),
      port: z.number().int().min(0).max(65535),
      allowedOrigins: z.array(remoteOriginSchema),
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
  delegation: delegationSettingsSchema.parse({}),
  version: 1,
  appearance: { ...defaultAppearance },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  notifications: { settleSound: true },
  permissions: { allowlist: [] },
  remote: { enabled: false, port: 8787, allowedOrigins: [] },
  window: null,
}

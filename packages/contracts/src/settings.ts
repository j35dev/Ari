import { z } from 'zod'
import { delegationSettingsPatchSchema, delegationSettingsSchema } from './agent-control'
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
  'phosphor',
  'tungsten',
  'outrun',
  'redline',
  'voltage',
  'blueprint',
  'mulberry',
  'porcelain',
  'sandstone',
  'platinum',
  'ink',
])
export type ThemeIdSetting = z.infer<typeof themeIdSchema>

/** Either an explicit theme or 'system' (follow the OS color scheme). */
export const themeModeSchema = z.union([z.literal('system'), themeIdSchema])
export type ThemeMode = z.infer<typeof themeModeSchema>

/** Bundled wallpaper identifiers (the paintable scenes; 'none' handled below). */
export const wallpaperIdSchema = z.enum([
  'anime-city',
  'moon-landscape',
  'moon-landscape-2',
  'stillwater',
])
export type WallpaperIdSetting = z.infer<typeof wallpaperIdSchema>

/** A wallpaper selection: a bundled scene, or 'none' for the plain theme. */
export const wallpaperSchema = z.union([z.literal('none'), wallpaperIdSchema])
export type WallpaperSetting = z.infer<typeof wallpaperSchema>

/** The agent CLIs Ari drives; Ari Core is built in and has no connection to configure. */
export const cliKindSchema = driverKindSchema.exclude(['ari-core'])
export type CliKind = z.infer<typeof cliKindSchema>

/** The account every CLI already has: whatever it is signed into in its own home. */
export const DEFAULT_ACCOUNT = 'default'

/**
 * A further sign-in for one provider. The id names the account's own home
 * directory, so it is a slug and never changes; the label is the user's.
 */
export const providerAccountSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .refine((id) => id !== DEFAULT_ACCOUNT),
  label: z.string().trim().min(1).max(40),
})
export type ProviderAccount = z.infer<typeof providerAccountSchema>

const accountsSchema = z.array(providerAccountSchema).max(12)

/** How Ari reaches one installed agent CLI. */
export const providerConnectionSchema = z.object({
  /** Off hides the provider everywhere and stops Ari launching or probing it. */
  enabled: z.boolean().default(true),
  /** Absolute path to the CLI to run; empty means find it on PATH. */
  binaryPath: z.string().trim().max(1024).default(''),
  /** Sign-ins beyond the CLI's own; only providers with a relocatable home use it. */
  accounts: accountsSchema.default([]),
  /** The account turns run as: `default`, or the id of one in `accounts`. */
  activeAccount: z.string().max(32).default(DEFAULT_ACCOUNT),
})
export type ProviderConnection = z.infer<typeof providerConnectionSchema>

const defaultConnection = (): ProviderConnection => ({
  enabled: true,
  binaryPath: '',
  accounts: [],
  activeAccount: DEFAULT_ACCOUNT,
})

/** The id of the account in use, falling back to the default when the stored one is gone. */
export function activeAccountId(connection: ProviderConnection): string {
  return connection.accounts.some((account) => account.id === connection.activeAccount)
    ? connection.activeAccount
    : DEFAULT_ACCOUNT
}

const connectionsShape = <T extends z.ZodType>(field: () => T): Record<CliKind, T> => ({
  claude: field(),
  codex: field(),
  opencode: field(),
  grok: field(),
  pi: field(),
  hermes: field(),
})

export const providerConnectionsSchema = z.object(
  connectionsShape(() => providerConnectionSchema.default(defaultConnection)),
)
export type ProviderConnections = z.infer<typeof providerConnectionsSchema>

const defaultConnections = (): ProviderConnections => providerConnectionsSchema.parse({})

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
      /** Shell shows the Hive roster instead of the session sidebar. */
      hiveView: z.boolean().optional(),
    })
    .default(defaultAppearance),
  sessions: z
    .object({
      defaultDriverKind: driverKindSchema.nullable().default(null),
      defaultPermissionMode: permissionModeSchema.default('ask'),
    })
    .default({ defaultDriverKind: null, defaultPermissionMode: 'ask' }),
  providers: providerConnectionsSchema.default(defaultConnections),
  notifications: z
    .object({
      /** Soft chime when a turn settles; failures get their own muted tone. */
      settleSound: z.boolean().default(true),
      /** OS notification when a session finishes, fails or needs an answer while Ari is in the background. */
      desktop: z.boolean().default(true),
      /** "Playing Ari" on the user's Discord profile while Discord is running. */
      discordPresence: z.boolean().default(true),
    })
    .default({ settleSound: true, desktop: true, discordPresence: true }),
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
  delegation: delegationSettingsPatchSchema.optional(),
  appearance: z
    .object({
      themeId: themeIdSchema,
      mode: themeModeSchema,
      reducedMotion: z.boolean(),
      wallpaper: wallpaperSchema,
      hiveView: z.boolean(),
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
  /** Per provider, only the fields being changed; the rest keep their stored value. */
  providers: z
    .object(
      connectionsShape(() =>
        z
          // Accounts are not here on purpose: adding, removing and switching
          // one has side effects a plain settings write would skip.
          .object({ enabled: z.boolean(), binaryPath: z.string().trim().max(1024) })
          .partial()
          .optional(),
      ),
    )
    .partial()
    .optional(),
  notifications: z
    .object({
      settleSound: z.boolean(),
      desktop: z.boolean(),
      discordPresence: z.boolean(),
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
  providers: defaultConnections(),
  notifications: { settleSound: true, desktop: true, discordPresence: true },
  permissions: { allowlist: [] },
  remote: { enabled: false, port: 8787, allowedOrigins: [] },
  window: null,
}

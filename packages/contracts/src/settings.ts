import { z } from 'zod'
import { delegationSettingsPatchSchema, delegationSettingsSchema } from './agent-control'
import { DEFAULT_PERMISSION_MODE, driverKindSchema, permissionModeSchema } from './common'
import { remoteOriginSchema } from './remote'

export function defaultSpeechShortcut(platform: string): string {
  return platform === 'darwin' ? 'shift+meta+space' : 'ctrl+alt+space'
}

export function defaultDictationShortcut(platform: string): string {
  return platform === 'darwin' ? 'shift+meta+d' : 'ctrl+alt+d'
}

export function speechBindingsError(
  aria: string,
  dictation: string,
  platform: string,
): string | null {
  const invalid = speechBindingError(aria, platform) ?? speechBindingError(dictation, platform)
  if (invalid) return invalid
  if (aria === dictation)
    return 'Aria dictation and general dictation must use different shortcuts.'
  return null
}

/** Validate one persisted binding, including Ari's context-local actions. */
export function speechBindingError(shortcut: string, platform: string): string | null {
  const invalid = speechShortcutError(shortcut, platform)
  if (invalid) return invalid
  const parts = shortcut.split('+')
  const key = parts.pop()!
  const ctrl = parts.includes('ctrl')
  const meta = parts.includes('meta')
  const alt = parts.includes('alt')
  const shift = parts.includes('shift')
  // App.tsx and Composer accept some actions with extra modifiers, and either
  // Ctrl or Cmd on all platforms. Reserve their actual matching conditions.
  const appAction =
    key === 'enter' ||
    (ctrl && !alt && !shift && key === 'b') ||
    (ctrl && !meta && !alt && key === 'backquote') ||
    ((ctrl || meta) &&
      (key === 'k' ||
        key === 's' ||
        (shift && key === 'f') ||
        /^[1-9]$/.test(key) ||
        (!alt && (key === 'backslash' || (!shift && ['n', '0'].includes(key)))) ||
        (alt && !shift && ['t', 'w'].includes(key))))
  return appAction ? `${shortcut} is already used by Ari. Choose another shortcut.` : null
}

const speechModifierOrder = ['ctrl', 'alt', 'shift', 'meta']
const speechModifiers = new Set(speechModifierOrder)
const speechPunctuation = new Set([
  'comma',
  'period',
  'slash',
  'semicolon',
  'quote',
  'backquote',
  'minus',
  'equal',
  'bracketleft',
  'bracketright',
  'backslash',
])
const reservedSpeechShortcuts = new Set([
  'alt+tab',
  'alt+f4',
  'ctrl+alt+delete',
  'meta+tab',
  'meta',
])

export function speechShortcutError(shortcut: string, platform?: string): string | null {
  if (shortcut !== shortcut.trim() || shortcut !== shortcut.toLowerCase())
    return 'Use a lowercase shortcut without spaces around the + signs.'
  if (
    reservedSpeechShortcuts.has(shortcut) ||
    (platform === 'darwin' && ['meta+q', 'meta+space', 'ctrl+space'].includes(shortcut)) ||
    (platform !== undefined && platform !== 'darwin' && ['meta+l', 'meta+d'].includes(shortcut))
  )
    return `${shortcut} is reserved by the operating system. Choose another shortcut.`
  const parts = shortcut.split('+')
  const key = parts.pop() ?? ''
  if (speechModifiers.has(key))
    return 'Add a key to the modifier, or use F1–F24 alone. Modifier-only shortcuts are not supported.'
  if (
    parts.some((modifier) => !speechModifiers.has(modifier)) ||
    new Set(parts).size !== parts.length
  )
    return 'Use each modifier once, before exactly one key.'
  if (
    parts.join('+') !== speechModifierOrder.filter((modifier) => parts.includes(modifier)).join('+')
  )
    return 'Use modifiers in this order: ctrl, alt, shift, meta.'
  if (key === 'tab') return 'Tab cannot be used as the hold-to-talk shortcut.'
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.test(key)
  if (
    !functionKey &&
    !/^[a-z0-9]$/.test(key) &&
    !['space', 'enter'].includes(key) &&
    !speechPunctuation.has(key)
  )
    return 'Use a letter, number, punctuation key, Space, Enter, or F1–F24.'
  if (!parts.length && !functionKey) return 'Add at least one modifier, or use F1–F24 alone.'
  return null
}

export function migrateSpeechShortcut(shortcut: string, platform: string): string {
  return speechBindingError(shortcut, platform) ? defaultSpeechShortcut(platform) : shortcut
}

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

export const interfaceFontSchema = z.enum([
  'theme',
  'geist',
  'system',
  'mono',
  'serif',
  'jetbrains-mono',
  'fira-code',
  'manrope',
  'source-sans',
  'source-serif',
])
export const codeFontSchema = z.enum([
  'geist-mono',
  'jetbrains-mono',
  'fira-code',
  'cascadia',
  'system-mono',
])
export const interfaceFontSizeSchema = z.union([
  z.literal(14),
  z.literal(15),
  z.literal(16),
  z.literal(17),
  z.literal(18),
])
// Preserve preferences from previews that offered oversized text settings.
const savedInterfaceFontSizeSchema = z.preprocess(
  (value) => (value === 19 || value === 20 || value === 22 ? 18 : value),
  interfaceFontSizeSchema,
)
export const chatWidthSchema = z.enum(['focused', 'balanced', 'comfortable', 'wide', 'full'])
export const chatStyleSchema = z.enum(['conversation', 'terminal'])

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
  fontFamily: 'theme',
  codeFont: 'geist-mono',
  fontSize: 16,
  chatWidth: 'comfortable',
  chatStyle: 'conversation',
} as const

/** Completion is optional so pre-onboarding installations migrate without losing settings. */
const onboardingSchema = z.object({ completedAt: z.number().int().nonnegative().nullable() })

export const ariaVoiceSettingsSchema = z.object({
  mode: z.enum(['voice-replies', 'off']).default('voice-replies'),
  engine: z.enum(['kokoro', 'groq']).default('kokoro'),
  kokoroVoice: z.enum(['af_heart', 'am_michael']).default('af_heart'),
  groqVoice: z.enum(['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy']).default('troy'),
  speed: z.number().min(0.75).max(1.3).default(1),
  volume: z.number().min(0).max(1).default(1),
})

export const speechSettingsSchema = z.object({
  provider: z.enum(['local', 'groq']).default('local'),
  groqModel: z
    .enum(['whisper-large-v3-turbo', 'whisper-large-v3'])
    .default('whisper-large-v3-turbo'),
  enabled: z.boolean().default(false),
  modelId: z.string().nullable().default(null),
  modelPath: z.string().nullable().default(null),
  // The legacy key keeps its Aria-specific intent. Empty files use the host default.
  shortcut: z.string().trim().max(80).default(''),
  dictationShortcut: z.string().trim().max(80).default(''),
  duckAudio: z.boolean().default(true),
})

/** Persisted application settings. Versioned for forward migration. */
export const settingsSchema = z.object({
  experimental: z
    .object({ ariaEnabled: z.boolean().default(false) })
    .default({ ariaEnabled: false }),
  ariaVoice: ariaVoiceSettingsSchema.default(() => ariaVoiceSettingsSchema.parse({})),
  speech: speechSettingsSchema.default(() => speechSettingsSchema.parse({})),
  onboarding: onboardingSchema.optional(),
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
      fontFamily: interfaceFontSchema.default(defaultAppearance.fontFamily),
      codeFont: codeFontSchema.default(defaultAppearance.codeFont),
      fontSize: savedInterfaceFontSizeSchema.default(defaultAppearance.fontSize),
      chatWidth: chatWidthSchema.default(defaultAppearance.chatWidth),
      chatStyle: chatStyleSchema.default(defaultAppearance.chatStyle),
    })
    .default(defaultAppearance),
  sessions: z
    .object({
      defaultDriverKind: driverKindSchema.nullable().default(null),
      defaultPermissionMode: permissionModeSchema.default(DEFAULT_PERMISSION_MODE),
    })
    .default({ defaultDriverKind: null, defaultPermissionMode: DEFAULT_PERMISSION_MODE }),
  providers: providerConnectionsSchema.default(defaultConnections),
  /** How the titlebar Git control and the diff panel behave. */
  sourceControl: z
    .object({
      /** Ask before pushing straight to main, master, trunk or develop. */
      confirmDefaultPush: z.boolean().default(true),
      /** Open new pull requests as drafts. */
      draftPullRequests: z.boolean().default(false),
      /** Seconds between background `git fetch` runs for the open project; 0 turns it off. */
      fetchIntervalSeconds: z.number().int().min(0).max(3600).default(60),
      /** How a diff opens before the user picks: side by side or one column. */
      diffView: z.enum(['split', 'unified']).default('split'),
      /** Wrap long lines in diffs instead of scrolling sideways. */
      wrapDiffLines: z.boolean().default(false),
      /** Undefined retains migration compatibility; the UI defaults to the full workspace. */
      diffOpenMode: z.enum(['workspace', 'sidebar']).optional(),
    })
    .default({
      confirmDefaultPush: true,
      draftPullRequests: false,
      fetchIntervalSeconds: 60,
      diffView: 'split',
      wrapDiffLines: false,
    }),
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
  ariaVoice: ariaVoiceSettingsSchema.partial().optional(),
  experimental: z.object({ ariaEnabled: z.boolean() }).partial().optional(),
  speech: z
    .object({
      provider: z.enum(['local', 'groq']),
      groqModel: z.enum(['whisper-large-v3-turbo', 'whisper-large-v3']),
      enabled: z.boolean(),
      duckAudio: z.boolean(),
      modelId: z.string().nullable(),
      modelPath: z.string().nullable(),
      shortcut: z
        .string()
        .max(80)
        .superRefine((value, context) => {
          const error = speechShortcutError(value)
          if (error) context.addIssue({ code: 'custom', message: error })
        }),
      dictationShortcut: z
        .string()
        .max(80)
        .superRefine((value, context) => {
          const error = speechShortcutError(value)
          if (error) context.addIssue({ code: 'custom', message: error })
        }),
    })
    .partial()
    .superRefine((value, context) => {
      if (value.shortcut !== undefined && value.shortcut === value.dictationShortcut)
        context.addIssue({
          code: 'custom',
          message: 'Aria dictation and general dictation must use different shortcuts.',
        })
    })
    .optional(),
  onboarding: onboardingSchema.optional(),
  delegation: delegationSettingsPatchSchema.optional(),
  appearance: z
    .object({
      themeId: themeIdSchema,
      mode: themeModeSchema,
      reducedMotion: z.boolean(),
      wallpaper: wallpaperSchema,
      fontFamily: interfaceFontSchema,
      codeFont: codeFontSchema,
      fontSize: interfaceFontSizeSchema,
      chatWidth: chatWidthSchema,
      chatStyle: chatStyleSchema,
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
  sourceControl: z
    .object({
      confirmDefaultPush: z.boolean(),
      draftPullRequests: z.boolean(),
      fetchIntervalSeconds: z.number().int().min(0).max(3600),
      diffView: z.enum(['split', 'unified']),
      wrapDiffLines: z.boolean(),
      diffOpenMode: z.enum(['workspace', 'sidebar']),
    })
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
  ariaVoice: ariaVoiceSettingsSchema.parse({}),
  experimental: { ariaEnabled: false },
  speech: speechSettingsSchema.parse({}),
  delegation: delegationSettingsSchema.parse({}),
  version: 1,
  appearance: { ...defaultAppearance },
  sessions: { defaultDriverKind: null, defaultPermissionMode: DEFAULT_PERMISSION_MODE },
  providers: defaultConnections(),
  sourceControl: {
    confirmDefaultPush: true,
    draftPullRequests: false,
    fetchIntervalSeconds: 60,
    diffView: 'split',
    wrapDiffLines: false,
  },
  notifications: { settleSound: true, desktop: true, discordPresence: true },
  permissions: { allowlist: [] },
  remote: { enabled: false, port: 8787, allowedOrigins: [] },
  window: null,
}

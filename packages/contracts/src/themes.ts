import { z } from 'zod'

export const bundledThemeIds = [
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
] as const

export const themePaletteRoles = [
  'bg',
  'surface-0',
  'surface-1',
  'surface-2',
  'surface-3',
  'border',
  'border-strong',
  'inner-stroke',
  'fg',
  'fg-muted',
  'fg-subtle',
  'fg-on-accent',
  'accent',
  'accent-hover',
  'accent-active',
  'accent-subtle',
  'accent-ring',
  'success',
  'success-subtle',
  'warning',
  'warning-subtle',
  'danger',
  'danger-hover',
  'danger-subtle',
  'info',
  'info-subtle',
  'busy',
  'busy-subtle',
] as const

/** Stable visual slots, independent of Tailwind classes and component internals. */
export const themeParts = [
  'app',
  'frame',
  'stage',
  'sidebar',
  'brand',
  'titlebar',
  'panel',
  'widget',
  'dictation-indicator',
  'composer',
  'composer-input',
  'transcript',
  'user-message',
  'assistant-message',
  'tool-call',
  'notice',
  'button',
  'primary-button',
  'outline-button',
  'icon-button',
  'icon',
  'input',
  'textarea',
  'select',
  'checkbox',
  'switch',
  'tab',
  'list-row',
  'menu',
  'menu-item',
  'dialog',
  'popover',
  'tooltip',
  'toast',
  'badge',
  'separator',
  'code',
  'link',
  'heading',
  'text',
  'table',
  'table-header',
  'table-cell',
  'file-editor',
  'diff',
  'terminal',
  'terminal-workspace',
  'terminal-pane',
  'terminal-header',
  'terminal-tabs',
  'terminal-sidebar',
  'terminal-toolbar',
  'settings-card',
  'settings-row',
  'empty-state',
  'skeleton',
  'progress',
  'scrollbar',
] as const
export type ThemePart = (typeof themeParts)[number]
export const customThemeIdSchema = z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,63}$/)
export const themeSelectionSchema = z.union([z.enum(bundledThemeIds), customThemeIdSchema])
export type ThemeSelection = z.infer<typeof themeSelectionSchema>

// Data only: no CSS text, URLs, selectors, scripts, external fonts or layout commands.
export const themeColorSchema = z
  .string()
  .regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/, 'Use #RRGGBB or #RRGGBBAA.')
export const themeFonts = [
  'geist',
  'manrope',
  'source-sans',
  'source-serif',
  'geist-mono',
  'jetbrains-mono',
  'fira-code',
] as const
const shadowSchema = z
  .object({
    x: z.number().min(-24).max(24),
    y: z.number().min(-24).max(24),
    blur: z.number().min(0).max(48),
    spread: z.number().min(-8).max(8).default(0),
    color: themeColorSchema,
    inset: z.boolean().default(false),
  })
  .strict()

export const themeVisualStyleSchema = z
  .object({
    color: themeColorSchema.optional(),
    backgroundColor: themeColorSchema.optional(),
    borderColor: themeColorSchema.optional(),
    borderWidth: z.number().min(0).max(3).optional(),
    borderStyle: z.enum(['solid', 'dashed', 'dotted', 'double']).optional(),
    borderRadius: z.number().min(0).max(28).optional(),
    font: z.enum(themeFonts).optional(),
    fontSize: z.number().min(11).max(22).optional(),
    fontWeight: z.number().int().min(300).max(800).optional(),
    letterSpacing: z.number().min(-0.5).max(2).optional(),
    lineHeight: z.number().min(1.2).max(1.8).optional(),
    shadow: z.array(shadowSchema).max(3).optional(),
    gradient: z
      .object({ angle: z.number().min(0).max(360), from: themeColorSchema, to: themeColorSchema })
      .strict()
      .optional(),
    strokeWidth: z.number().min(1).max(3).optional(),
  })
  .strict()
export type ThemeVisualStyle = z.infer<typeof themeVisualStyleSchema>
const partSchema = z
  .object({
    default: themeVisualStyleSchema.optional(),
    hover: themeVisualStyleSchema.optional(),
    active: themeVisualStyleSchema.optional(),
    selected: themeVisualStyleSchema.optional(),
    focus: themeVisualStyleSchema.optional(),
    disabled: themeVisualStyleSchema.optional(),
  })
  .strict()

/** Contrast of opaque hex colors; theme validation never depends on a browser. */
export function hexContrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const s = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Image and font files a theme ships with. Ari stores them by content hash. */
export const themeAssetExtensions = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'svg',
  'woff2',
] as const
export const themeAssetNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,47}\.(?:png|jpe?g|webp|gif|avif|svg|woff2)$/,
    'Use a lowercase file name such as wallpaper.jpg (png, jpg, webp, gif, avif, svg or woff2).',
  )
export const themeAssetSchema = z
  .object({
    name: themeAssetNameSchema,
    /** Filled in by Ari when the file is stored; leave it out when authoring. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
export type ThemeAsset = z.infer<typeof themeAssetSchema>
const NAMED_FOCUS = {
  center: { x: 50, y: 50 },
  top: { x: 50, y: 0 },
  bottom: { x: 50, y: 100 },
  left: { x: 0, y: 50 },
  right: { x: 100, y: 50 },
} as const
/** A wallpaper position as percentages of the image. */
export function wallpaperFocus(position: keyof typeof NAMED_FOCUS | { x: number; y: number }): {
  x: number
  y: number
} {
  return typeof position === 'string' ? NAMED_FOCUS[position] : position
}
export const THEME_CSS_MAX = 50_000
export const THEME_ASSET_MAX_BYTES = 12 * 1024 * 1024
export const THEME_ASSETS_MAX_BYTES = 40 * 1024 * 1024
/** Scheme the renderer loads stored theme files from. */
export const THEME_ASSET_SCHEME = 'ari-theme-asset'
export const themeAssetUrl = (asset: { name: string; sha256: string }) =>
  `${THEME_ASSET_SCHEME}://a/${asset.sha256}.${asset.name.split('.').pop()}`

const URL_TARGET = /url\(\s*(["']?)([^"')\s]*)/gi
/** Names of `url("asset:NAME")` references in theme CSS. */
export function themeCssAssetRefs(css: string): string[] {
  const refs = new Set<string>()
  for (const match of stripCssComments(css).matchAll(URL_TARGET)) {
    const target = match[2] ?? ''
    if (target.toLowerCase().startsWith('asset:')) refs.add(target.slice(6))
  }
  return [...refs]
}
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
/**
 * Why theme CSS would be refused, or null. CSS must never load from the network:
 * a url() on an attribute selector could send what is on screen to another host.
 * Only `asset:` (the theme's own files), `data:` and `#id` targets are allowed, and
 * backslashes are refused so CSS escapes cannot spell a function name past the check.
 */
export function themeCssProblem(css: string): string | null {
  if (css.includes('\\'))
    return 'Theme CSS cannot contain backslashes. Write characters and emoji literally.'
  // Comments are not stripped first: a "/*" inside a string opens no comment, and
  // stripping from there would hide the real rules that follow it.
  if (/@import/i.test(css)) return 'Theme CSS cannot use @import.'
  if (/image-set\(|\bsrc\(/i.test(css)) return 'Theme CSS cannot use image-set() or src().'
  for (const match of css.matchAll(URL_TARGET)) {
    const target = (match[2] ?? '').toLowerCase()
    if (!/^(?:asset:|data:|#)/.test(target))
      return `url(${match[2] ?? ''}) is not allowed. Use url("asset:<file>") for the theme's own files, or a data: address.`
  }
  return null
}

export const customThemeSchema = z
  .object({
    version: z.literal(1),
    id: customThemeIdSchema,
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(240).default(''),
    base: z.enum(bundledThemeIds),
    colors: z.partialRecord(z.enum(themePaletteRoles), themeColorSchema),
    typography: z
      .object({
        ui: z.enum(themeFonts).optional(),
        mono: z.enum(['geist-mono', 'jetbrains-mono', 'fira-code']).optional(),
      })
      .strict()
      .optional(),
    radii: z
      .object({
        sm: z.number().min(0).max(20).optional(),
        md: z.number().min(0).max(24).optional(),
        lg: z.number().min(0).max(28).optional(),
        xl: z.number().min(0).max(28).optional(),
        '2xl': z.number().min(0).max(28).optional(),
      })
      .strict()
      .optional(),
    shadows: z
      .object({
        '1': z.array(shadowSchema).max(3).optional(),
        '2': z.array(shadowSchema).max(3).optional(),
        '3': z.array(shadowSchema).max(3).optional(),
      })
      .strict()
      .optional(),
    scene: z.enum(['default', 'none']).default('default'),
    /** Files stored with the theme: wallpapers, stickers, icons and fonts. */
    assets: z.array(themeAssetSchema).max(32).optional(),
    /** A theme image painted behind the whole window, replacing the bundled wallpaper. */
    wallpaper: z
      .object({
        asset: themeAssetNameSchema,
        /** Blur in px on the window plate. The empty-session art always shows sharp. */
        blur: z.number().min(0).max(40).default(28),
        /** How much of the surface color covers the image, in percent. */
        tint: z.number().min(0).max(95).default(72),
        /**
         * Where the art's subject is, kept in view as the window resizes: a named edge,
         * or { x, y } in percent of the image (0,0 is top left).
         */
        position: z
          .union([
            z.enum(['center', 'top', 'bottom', 'left', 'right']),
            z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).strict(),
          ])
          .default('center'),
      })
      .strict()
      .optional(),
    /** Extra CSS applied after Ari's styles while the theme is painted. */
    css: z.string().max(THEME_CSS_MAX).optional(),
    /** Bounded spacing presets preserve Ari's structural layout. */
    density: z.enum(['compact', 'comfortable', 'spacious']).default('comfortable'),
    parts: z.partialRecord(z.enum(themeParts), partSchema).default({}),
  })
  .strict()
  .superRefine((theme, ctx) => {
    const assetNames = new Set((theme.assets ?? []).map((asset) => asset.name))
    if (assetNames.size !== (theme.assets ?? []).length)
      ctx.addIssue({ code: 'custom', path: ['assets'], message: 'Asset names must be unique.' })
    if (theme.wallpaper && !assetNames.has(theme.wallpaper.asset))
      ctx.addIssue({
        code: 'custom',
        path: ['wallpaper', 'asset'],
        message: `List ${theme.wallpaper.asset} in assets.`,
      })
    if (theme.css !== undefined) {
      const problem = themeCssProblem(theme.css)
      if (problem) ctx.addIssue({ code: 'custom', path: ['css'], message: problem })
      for (const ref of themeCssAssetRefs(theme.css))
        if (!assetNames.has(ref))
          ctx.addIssue({ code: 'custom', path: ['css'], message: `List ${ref} in assets.` })
    }
    for (const role of ['bg', 'fg', 'accent', 'fg-on-accent'] as const) {
      const color = theme.colors[role]
      if (!color || (color.length === 9 && !color.endsWith('ff') && !color.endsWith('FF')))
        ctx.addIssue({
          code: 'custom',
          path: ['colors', role],
          message: 'An opaque color is required.',
        })
    }
    for (const [fgRole, bgRole] of [
      ['fg', 'bg'],
      ['fg-on-accent', 'accent'],
    ] as const) {
      const fg = theme.colors[fgRole],
        bg = theme.colors[bgRole]
      if (fg && bg && hexContrast(fg, bg) < 4.5)
        ctx.addIssue({
          code: 'custom',
          path: ['colors', fgRole],
          message: 'Text contrast must be at least 4.5:1.',
        })
    }
    for (const role of ['fg-muted', 'fg-subtle'] as const) {
      const color = theme.colors[role]
      if (color?.length === 9 && color.slice(7).toLowerCase() !== 'ff')
        ctx.addIssue({ code: 'custom', path: ['colors', role], message: 'Text must be opaque.' })
    }
    for (const [part, states] of Object.entries(theme.parts)) {
      for (const [state, style] of Object.entries(states)) {
        if (
          style.color &&
          style.backgroundColor &&
          hexContrast(style.color, style.backgroundColor) < 4.5
        )
          ctx.addIssue({
            code: 'custom',
            path: ['parts', part, state],
            message: 'Text contrast must be at least 4.5:1.',
          })
        if (style.color && style.color.length === 9 && style.color.slice(7).toLowerCase() !== 'ff')
          ctx.addIssue({
            code: 'custom',
            path: ['parts', part, state, 'color'],
            message: 'Text must be opaque.',
          })
      }
    }
  })
export type CustomTheme = z.infer<typeof customThemeSchema>
export const customThemeLibrarySchema = z
  .array(customThemeSchema)
  .max(50)
  .refine(
    (themes) => new Set(themes.map((theme) => theme.id)).size === themes.length,
    'Theme IDs must be unique.',
  )
  .refine(
    (themes) => JSON.stringify(themes).length <= 512_000,
    'The theme library must fit within 500 KiB. Export unused themes to free space.',
  )

export interface ThemeLibraryEvent {
  themes: CustomTheme[]
  previewId?: string
  reset?: boolean
}
export const themeLibraryEventSchema = z
  .object({
    themes: customThemeLibrarySchema,
    previewId: customThemeIdSchema.optional(),
    reset: z.boolean().optional(),
  })
  .strict()

export const neonThemeExample: CustomTheme = customThemeSchema.parse({
  version: 1,
  id: 'custom:neon',
  name: 'Neon circuit',
  description: 'Cyan light on midnight graphite.',
  base: 'obsidian',
  colors: {
    bg: '#090e17',
    'surface-0': '#101726',
    'surface-1': '#151e30',
    'surface-2': '#1c2940',
    'surface-3': '#24334e',
    fg: '#edfaff',
    'fg-muted': '#b4cddc',
    'fg-subtle': '#95acbf',
    accent: '#54f2e4',
    'accent-hover': '#85fff3',
    'accent-active': '#29d5c7',
    'fg-on-accent': '#071c20',
    border: '#54f2e42b',
    'border-strong': '#54f2e461',
    'accent-subtle': '#54f2e41f',
    'accent-ring': '#54f2e480',
  },
  typography: { ui: 'manrope', mono: 'jetbrains-mono' },
  radii: { sm: 4, md: 6, lg: 10, xl: 12, '2xl': 14 },
  parts: {
    composer: {
      default: {
        borderColor: '#54f2e461',
        borderWidth: 1,
        shadow: [{ x: 0, y: 0, blur: 24, color: '#54f2e41a' }],
      },
    },
    'primary-button': {
      default: { backgroundColor: '#54f2e4', color: '#071c20' },
      hover: { backgroundColor: '#85fff3' },
    },
    sidebar: { default: { gradient: { angle: 160, from: '#101726', to: '#090e17' } } },
  },
})

/**
 * Parts that match many elements at once: every clickable row, every paragraph
 * block, every tool line. A border, shadow or resting fill on them boxes the
 * whole app, so they only take color, type and interaction-state fills.
 */
export const boxlessThemeParts: readonly ThemePart[] = [
  'button',
  'icon-button',
  'icon',
  'text',
  'heading',
  'link',
  'notice',
  'assistant-message',
  'tool-call',
  'list-row',
  'menu-item',
  'tab',
  'table-cell',
  'separator',
]
const BOX_PROPS = ['borderColor', 'borderWidth', 'borderStyle', 'borderRadius', 'shadow'] as const
/** Box properties a boxless part would get in this state. */
export function boxlessViolations(
  part: string,
  state: string,
  style: ThemeVisualStyle,
): (keyof ThemeVisualStyle)[] {
  if (!(boxlessThemeParts as readonly string[]).includes(part)) return []
  const found: (keyof ThemeVisualStyle)[] = BOX_PROPS.filter((prop) => style[prop] !== undefined)
  if (state === 'default' || state === 'disabled') {
    if (style.backgroundColor !== undefined && !/^#[\da-f]{6}00$/i.test(style.backgroundColor))
      found.push('backgroundColor')
    if (style.gradient !== undefined) found.push('gradient')
  }
  return found
}
/** Design rules checked when an agent validates or installs a theme. */
export function themeDesignProblems(theme: CustomTheme): string[] {
  const problems: string[] = []
  for (const [part, states] of Object.entries(theme.parts))
    for (const [state, style] of Object.entries(states ?? {})) {
      const props = boxlessViolations(part, state, style)
      if (props.length)
        problems.push(
          `parts.${part}.${state}: remove ${props.join(', ')}. ${part} matches many elements at once, so this would box the whole app. Use color and type, plus a background only for hover, active, selected or focus.`,
        )
    }
  return problems
}

/** What an agent needs to design a theme well. `ari theme schema` returns it. */
export const themeAuthoringGuide = [
  'A theme is a palette plus optional CSS, image/font assets and a wallpaper. Keep everything for one theme in its own folder: theme.json next to its images.',
  '',
  'Workflow:',
  '1. `ari theme schema --json` for the schema, CSS hooks and an example.',
  '2. Make the assets. For a wallpaper, generate one with your image tool if you have one; otherwise download a high-quality image (1920px wide or more, jpg/webp/png, under 12 MB) from the web into the folder with curl or Invoke-WebRequest, and check that the file really is an image.',
  '3. List each file in `assets` by name (for example {"name":"wallpaper.jpg"}). Leave `sha256` out; Ari fills it in.',
  "4. `ari theme validate --file <folder>/theme.json --json`, then `ari theme install --file <folder>/theme.json --preview --json`. Install reads the listed files from the theme file's folder (or `--assets <dir>`). A revision with the same ID keeps files already stored under the same names.",
  '5. `ari theme screenshot --json` saves a PNG of the Ari window and returns its path. Open it and go through this checklist honestly; fix every no and install again. A preview lasts 30 seconds; installing with --preview restarts it.',
  "   - Is the wallpaper's subject (the moon, the character, the ship) clearly visible, not hidden behind the sidebar or sitting right under the chat text?",
  '   - Does the window read as one calm surface? No panel, row, message or line has its own box unless it truly needs one.',
  '   - Is every line of text easy to read against what is behind it?',
  '   - Does each decoration appear once, fully visible, not clipped at an edge or repeated?',
  '   - Would a designer ship this? If it looks busy, muddy or cheap, remove things rather than add them.',
  '6. Show the user, ask how it looks, and keep iterating with them.',
  '',
  'Wallpaper: `wallpaper.asset` names an asset painted behind the whole window (Ari hides its own dot-art scene while one is set). The empty-session area always shows the art sharp; elsewhere the window plate shows it through `tint` (0-95, default 72: how much surface color covers it) and `blur` (0-40 px).',
  'Composition: the sidebar covers the left 280 px and chat text runs down the middle, so pick art whose subject can sit in the open right half, and set `position` to the subject\'s location in the image as {x, y} percentages (for a moon at the image\'s upper right, {"x": 75, "y": 30}). Keep the sidebar, frame and stage on the shared plate: do not give them their own backgrounds or gradients, in parts or in CSS.',
  'Ari already shows the art sharp on an empty session and as a soft glow while a chat runs, behind a reading backdrop (`.ari-reading-lane`). Keep that: leave `blur` at 20 or more (the default 28 is right for most art) and never make the reading backdrop or transcript transparent. Sharp art behind chat text looks busy and is hard to read. Lower `tint` (30-50) if the art should glow more strongly.',
  '',
  "CSS (`css`, up to 50,000 characters) applies after Ari's styles while the theme is painted. Use the stable hooks below; other class names are Tailwind utilities and change between releases. Add !important when Ari's own rule wins.",
  '- Emoji and text decorations: ::before/::after with `content: "🏴‍☠️"`. Write emoji literally; backslashes are refused.',
  '- Images: `url("asset:sticker.png")` for the theme\'s own files, or a small data: SVG. Nothing may load from the network: no http(s) urls, @import, image-set() or src().',
  '- Icons are `svg.lucide`: recolor with color/stroke, or hide one and paint an asset in a ::before.',
  '- Fonts: @font-face { font-family: "Pirate"; src: url("asset:pirate.woff2") format("woff2") } and use it in font-family.',
  '- `--ari-wallpaper-pane` sets the plate color over the wallpaper; `.ari-session-scene` is the sharp art behind an empty session.',
  '',
  'Parts are optional fine-tuning, not a checklist. Most good themes set fewer than eight. Broad parts (button, list-row, text, assistant-message, tool-call and the like) match many elements at once and refuse borders, shadows and resting fills.',
  '',
  'Design with restraint. A strong theme comes from a good palette, the wallpaper, and personality in a few focal places: the brand mark, the empty state, the accent color, one or two stickers or emoji. Do not add borders, boxes or shadows to every part; most surfaces should stay calm and quiet, with hairline borders at most. Keep text contrast high and controls recognizable.',
  '',
  'Undo: `ari theme reset --json` restores the default theme. The user can also press Ctrl/⌘+Alt+Shift+T.',
].join('\n')

/** Recognized only at the beginning of a user prompt. Keep original transcript text. */
export function themeAuthoringPrompt(text: string): string {
  const match = /^\/ari\s+theme(?:\s+([\s\S]+))?$/i.exec(text.trim())
  if (!match) return text
  const brief = match[1]?.trim() || 'Design a distinctive custom theme for Ari.'
  return (
    `Create a custom Ari theme for this request: ${brief}\n\n` +
    'Use the Ari theme API, not edits to this project or Ari source code. Run `ari theme schema --json` first: ' +
    'it returns the JSON schema, the CSS hooks, a complete example and a design guide. Follow that guide. ' +
    'Make the theme feel like the request, not just a recolor: a fitting wallpaper (generate or download one into the theme folder), ' +
    'a palette drawn from it, and a few tasteful touches in CSS such as emoji, stickers or a themed brand mark. ' +
    'Validate with `ari theme validate --file <path> --json`, install with `ari theme install --file <path> --preview --json`, ' +
    'then check the result with `ari theme screenshot --json` and fix what looks wrong. ' +
    'Use a unique custom:<slug> ID, or preserve the ID when the user asks to revise an existing theme. ' +
    'Tell the user the theme name, that they can keep or revert the preview, and ask how it looks so you can refine it together. ' +
    'It stays available in Settings → Appearance → Your themes.'
  )
}

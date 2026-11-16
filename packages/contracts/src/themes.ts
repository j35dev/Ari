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
  'approval',
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
    /** Bounded spacing presets preserve Ari's structural layout. */
    density: z.enum(['compact', 'comfortable', 'spacious']).default('comfortable'),
    parts: z.partialRecord(z.enum(themeParts), partSchema).default({}),
  })
  .strict()
  .superRefine((theme, ctx) => {
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

/** Recognized only at the beginning of a user prompt. Keep original transcript text. */
export function themeAuthoringPrompt(text: string): string {
  const match = /^\/ari\s+theme(?:\s+([\s\S]+))?$/i.exec(text.trim())
  if (!match) return text
  const brief = match[1]?.trim() || 'Design a distinctive custom theme for Ari.'
  return (
    `Create a custom Ari theme for this request: ${brief}\n\n` +
    'Use the Ari theme API, not edits to this project or Ari source code. Run `ari theme schema --json` ' +
    'to get the current JSON schema, visual slots and a complete example, and `ari theme list --json` to inspect ' +
    'the library. Write a version 1 theme JSON file in the workspace, validate with `ari theme validate --file <path> --json`, ' +
    'then save it with `ari theme install --file <path> --preview --json`. On validation failure, fix the reported fields ' +
    'and validate again. Use a unique custom:<slug> ID, or preserve the ID when the user asks to revise an existing theme. ' +
    'Customize the palette, typography, shape, shadows and relevant component states coherently. ' +
    'Ari controls behavior and geometry; the theme is data only. Save the completed package to the library and request a preview; ' +
    'the user keeps or reverts it. Report the theme name and that it is available in Settings → Appearance → Your themes.'
  )
}

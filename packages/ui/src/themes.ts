/**
 * Ari's theme registry. Each theme is a full palette for every color role the
 * design tokens expose; `tokens.css` mirrors these values as
 * `[data-ari-theme="<id>"]` blocks (CSS is the runtime source of truth, this
 * module is the typed catalog the UI and the main process read).
 *
 * Raw color literals are permitted in `tokens.css` only (AGENTS.md); the values
 * here are the same literals kept in TypeScript so the picker can preview them
 * and the window can pick an opaque backdrop before the renderer boots. A test
 * asserts the two stay in sync.
 */

/** Every color-bearing token name, minus the `--ari-` prefix. */
export const themeColorRoles = [
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
  'shadow-1',
  'shadow-2',
  'shadow-3',
] as const
export type ThemeColorRole = (typeof themeColorRoles)[number]

export const themeIds = [
  'obsidian',
  'graphite',
  'nocturne',
  'verdant',
  'porcelain',
  'sandstone',
] as const
export type ThemeId = (typeof themeIds)[number]

export interface Theme {
  id: ThemeId
  label: string
  /** One-line description shown under the label in the picker. */
  description: string
  scheme: 'light' | 'dark'
  colors: Record<ThemeColorRole, string>
}

export const defaultThemeId: ThemeId = 'obsidian'

const obsidian: Theme = {
  id: 'obsidian',
  label: 'Obsidian',
  description: 'Smoky plum, warm ivory and luminous coral.',
  scheme: 'dark',
  colors: {
    bg: 'oklch(0.15 0.016 305)',
    'surface-0': 'oklch(0.18 0.016 305)',
    'surface-1': 'oklch(0.225 0.016 305)',
    'surface-2': 'oklch(0.275 0.016 305)',
    'surface-3': 'oklch(0.33 0.016 305)',
    border: 'oklch(0.85 0.02 278 / 11%)',
    'border-strong': 'oklch(0.86 0.025 278 / 18%)',
    'inner-stroke': 'oklch(0.9 0.015 278 / 5%)',
    fg: 'oklch(0.95 0.012 305)',
    'fg-muted': 'oklch(0.77 0.018 305)',
    'fg-subtle': 'oklch(0.69 0.02 305)',
    'fg-on-accent': 'oklch(0.18 0.015 305)',
    accent: 'oklch(0.78 0.145 30)',
    'accent-hover': 'oklch(0.82 0.145 30)',
    'accent-active': 'oklch(0.72 0.145 30)',
    'accent-subtle': 'oklch(0.78 0.145 30 / 14%)',
    'accent-ring': 'oklch(0.78 0.145 30 / 45%)',
    success: 'oklch(0.755 0.175 162)',
    'success-subtle': 'oklch(0.755 0.175 162 / 14%)',
    warning: 'oklch(0.83 0.17 82)',
    'warning-subtle': 'oklch(0.83 0.17 82 / 14%)',
    danger: 'oklch(0.7 0.19 24)',
    'danger-hover': 'oklch(0.76 0.175 24)',
    'danger-subtle': 'oklch(0.7 0.19 24 / 15%)',
    info: 'oklch(0.78 0.13 212)',
    'info-subtle': 'oklch(0.78 0.13 212 / 14%)',
    busy: 'oklch(0.72 0.2 350)',
    'busy-subtle': 'oklch(0.72 0.2 350 / 14%)',
    'shadow-1': '0 1px 2px oklch(0 0 0 / 35%)',
    'shadow-2': '0 4px 16px oklch(0 0 0 / 40%)',
    'shadow-3': '0 12px 40px oklch(0 0 0 / 50%)',
  },
}

const graphite: Theme = {
  id: 'graphite',
  label: 'Graphite',
  description: 'Espresso charcoal with a molten amber accent.',
  scheme: 'dark',
  colors: {
    bg: 'oklch(0.17 0.014 65)',
    'surface-0': 'oklch(0.2 0.014 65)',
    'surface-1': 'oklch(0.245 0.014 65)',
    'surface-2': 'oklch(0.295 0.014 65)',
    'surface-3': 'oklch(0.35 0.014 65)',
    border: 'oklch(0.92 0.015 70 / 9%)',
    'border-strong': 'oklch(0.92 0.02 70 / 16%)',
    'inner-stroke': 'oklch(0.93 0.012 70 / 5%)',
    fg: 'oklch(0.95 0.012 65)',
    'fg-muted': 'oklch(0.77 0.018 65)',
    'fg-subtle': 'oklch(0.69 0.02 65)',
    'fg-on-accent': 'oklch(0.18 0.015 65)',
    accent: 'oklch(0.82 0.17 77)',
    'accent-hover': 'oklch(0.86 0.17 77)',
    'accent-active': 'oklch(0.76 0.17 77)',
    'accent-subtle': 'oklch(0.82 0.17 77 / 14%)',
    'accent-ring': 'oklch(0.82 0.17 77 / 45%)',
    success: 'oklch(0.78 0.16 152)',
    'success-subtle': 'oklch(0.78 0.16 152 / 15%)',
    warning: 'oklch(0.85 0.15 95)',
    'warning-subtle': 'oklch(0.85 0.15 95 / 15%)',
    danger: 'oklch(0.7 0.185 26)',
    'danger-hover': 'oklch(0.755 0.17 26)',
    'danger-subtle': 'oklch(0.7 0.185 26 / 16%)',
    info: 'oklch(0.76 0.11 235)',
    'info-subtle': 'oklch(0.76 0.11 235 / 15%)',
    busy: 'oklch(0.75 0.15 330)',
    'busy-subtle': 'oklch(0.75 0.15 330 / 15%)',
    'shadow-1': '0 1px 2px oklch(0 0 0 / 40%)',
    'shadow-2': '0 4px 16px oklch(0 0 0 / 45%)',
    'shadow-3': '0 12px 40px oklch(0 0 0 / 55%)',
  },
}

const nocturne: Theme = {
  id: 'nocturne',
  label: 'Nocturne',
  description: 'Midnight blue with crisp turquoise highlights.',
  scheme: 'dark',
  colors: {
    bg: 'oklch(0.16 0.042 260)',
    'surface-0': 'oklch(0.19 0.042 260)',
    'surface-1': 'oklch(0.235 0.042 260)',
    'surface-2': 'oklch(0.285 0.042 260)',
    'surface-3': 'oklch(0.345 0.042 260)',
    border: 'oklch(0.8 0.06 250 / 14%)',
    'border-strong': 'oklch(0.82 0.07 250 / 22%)',
    'inner-stroke': 'oklch(0.9 0.04 250 / 7%)',
    fg: 'oklch(0.95 0.012 260)',
    'fg-muted': 'oklch(0.77 0.018 260)',
    'fg-subtle': 'oklch(0.69 0.02 260)',
    'fg-on-accent': 'oklch(0.18 0.015 260)',
    accent: 'oklch(0.83 0.13 185)',
    'accent-hover': 'oklch(0.87 0.13 185)',
    'accent-active': 'oklch(0.77 0.13 185)',
    'accent-subtle': 'oklch(0.83 0.13 185 / 14%)',
    'accent-ring': 'oklch(0.83 0.13 185 / 45%)',
    success: 'oklch(0.8 0.15 168)',
    'success-subtle': 'oklch(0.8 0.15 168 / 15%)',
    warning: 'oklch(0.845 0.16 88)',
    'warning-subtle': 'oklch(0.845 0.16 88 / 15%)',
    danger: 'oklch(0.71 0.19 15)',
    'danger-hover': 'oklch(0.765 0.175 15)',
    'danger-subtle': 'oklch(0.71 0.19 15 / 16%)',
    info: 'oklch(0.78 0.115 255)',
    'info-subtle': 'oklch(0.78 0.115 255 / 15%)',
    busy: 'oklch(0.75 0.17 305)',
    'busy-subtle': 'oklch(0.75 0.17 305 / 15%)',
    'shadow-1': '0 1px 2px oklch(0.05 0.03 270 / 45%)',
    'shadow-2': '0 4px 16px oklch(0.05 0.03 270 / 50%)',
    'shadow-3': '0 12px 40px oklch(0.04 0.03 270 / 60%)',
  },
}

const verdant: Theme = {
  id: 'verdant',
  label: 'Verdant',
  description: 'Evergreen ink with an electric citrus accent.',
  scheme: 'dark',
  colors: {
    bg: 'oklch(0.16 0.032 165)',
    'surface-0': 'oklch(0.19 0.032 165)',
    'surface-1': 'oklch(0.235 0.032 165)',
    'surface-2': 'oklch(0.285 0.032 165)',
    'surface-3': 'oklch(0.345 0.032 165)',
    border: 'oklch(0.88 0.045 150 / 13%)',
    'border-strong': 'oklch(0.9 0.05 150 / 22%)',
    'inner-stroke': 'oklch(0.92 0.03 150 / 6%)',
    fg: 'oklch(0.95 0.012 165)',
    'fg-muted': 'oklch(0.77 0.018 165)',
    'fg-subtle': 'oklch(0.69 0.02 165)',
    'fg-on-accent': 'oklch(0.18 0.015 165)',
    accent: 'oklch(0.86 0.17 115)',
    'accent-hover': 'oklch(0.9 0.17 115)',
    'accent-active': 'oklch(0.8 0.17 115)',
    'accent-subtle': 'oklch(0.86 0.17 115 / 14%)',
    'accent-ring': 'oklch(0.86 0.17 115 / 45%)',
    success: 'oklch(0.8 0.16 158)',
    'success-subtle': 'oklch(0.8 0.16 158 / 15%)',
    warning: 'oklch(0.84 0.16 78)',
    'warning-subtle': 'oklch(0.84 0.16 78 / 15%)',
    danger: 'oklch(0.71 0.185 30)',
    'danger-hover': 'oklch(0.765 0.17 30)',
    'danger-subtle': 'oklch(0.71 0.185 30 / 16%)',
    info: 'oklch(0.79 0.11 215)',
    'info-subtle': 'oklch(0.79 0.11 215 / 15%)',
    busy: 'oklch(0.78 0.15 195)',
    'busy-subtle': 'oklch(0.78 0.15 195 / 15%)',
    'shadow-1': '0 1px 2px oklch(0.05 0.02 150 / 42%)',
    'shadow-2': '0 4px 16px oklch(0.05 0.02 150 / 48%)',
    'shadow-3': '0 12px 40px oklch(0.04 0.02 150 / 58%)',
  },
}

const porcelain: Theme = {
  id: 'porcelain',
  label: 'Porcelain',
  description: 'Lavender porcelain with a rich berry accent.',
  scheme: 'light',
  colors: {
    bg: 'oklch(0.985 0.009 310)',
    'surface-0': 'oklch(0.967 0.009 310)',
    'surface-1': 'oklch(0.945 0.009 310)',
    'surface-2': 'oklch(0.91 0.009 310)',
    'surface-3': 'oklch(0.87 0.009 310)',
    border: 'oklch(0.22 0.02 285 / 11%)',
    'border-strong': 'oklch(0.22 0.02 285 / 20%)',
    'inner-stroke': 'oklch(1 0 0 / 70%)',
    fg: 'oklch(0.25 0.025 310)',
    'fg-muted': 'oklch(0.45 0.018 310)',
    'fg-subtle': 'oklch(0.49 0.02 310)',
    'fg-on-accent': 'oklch(0.99 0.002 310)',
    accent: 'oklch(0.49 0.19 335)',
    'accent-hover': 'oklch(0.445 0.19 335)',
    'accent-active': 'oklch(0.43 0.19 335)',
    'accent-subtle': 'oklch(0.49 0.19 335 / 14%)',
    'accent-ring': 'oklch(0.49 0.19 335 / 45%)',
    success: 'oklch(0.5 0.13 158)',
    'success-subtle': 'oklch(0.5 0.13 158 / 14%)',
    warning: 'oklch(0.55 0.13 70)',
    'warning-subtle': 'oklch(0.55 0.13 70 / 16%)',
    danger: 'oklch(0.5 0.2 25)',
    'danger-hover': 'oklch(0.44 0.2 25)',
    'danger-subtle': 'oklch(0.5 0.2 25 / 12%)',
    info: 'oklch(0.5 0.14 250)',
    'info-subtle': 'oklch(0.5 0.14 250 / 13%)',
    busy: 'oklch(0.52 0.19 340)',
    'busy-subtle': 'oklch(0.52 0.19 340 / 13%)',
    'shadow-1': '0 1px 2px oklch(0.3 0.02 285 / 10%)',
    'shadow-2': '0 4px 16px oklch(0.3 0.02 285 / 12%)',
    'shadow-3': '0 12px 40px oklch(0.3 0.02 285 / 16%)',
  },
}

const sandstone: Theme = {
  id: 'sandstone',
  label: 'Sandstone',
  description: 'Warm cream, walnut ink and vivid cobalt.',
  scheme: 'light',
  colors: {
    bg: 'oklch(0.98 0.023 80)',
    'surface-0': 'oklch(0.958 0.023 80)',
    'surface-1': 'oklch(0.936 0.023 80)',
    'surface-2': 'oklch(0.9 0.023 80)',
    'surface-3': 'oklch(0.855 0.023 80)',
    border: 'oklch(0.3 0.03 70 / 13%)',
    'border-strong': 'oklch(0.3 0.03 70 / 22%)',
    'inner-stroke': 'oklch(1 0 0 / 65%)',
    fg: 'oklch(0.25 0.025 80)',
    'fg-muted': 'oklch(0.45 0.018 80)',
    'fg-subtle': 'oklch(0.49 0.02 80)',
    'fg-on-accent': 'oklch(0.99 0.002 80)',
    accent: 'oklch(0.48 0.2 265)',
    'accent-hover': 'oklch(0.435 0.2 265)',
    'accent-active': 'oklch(0.42 0.2 265)',
    'accent-subtle': 'oklch(0.48 0.2 265 / 14%)',
    'accent-ring': 'oklch(0.48 0.2 265 / 45%)',
    success: 'oklch(0.485 0.13 150)',
    'success-subtle': 'oklch(0.485 0.13 150 / 15%)',
    warning: 'oklch(0.545 0.135 62)',
    'warning-subtle': 'oklch(0.545 0.135 62 / 17%)',
    danger: 'oklch(0.495 0.2 28)',
    'danger-hover': 'oklch(0.435 0.2 28)',
    'danger-subtle': 'oklch(0.495 0.2 28 / 13%)',
    info: 'oklch(0.505 0.13 240)',
    'info-subtle': 'oklch(0.505 0.13 240 / 13%)',
    busy: 'oklch(0.52 0.17 350)',
    'busy-subtle': 'oklch(0.52 0.17 350 / 13%)',
    'shadow-1': '0 1px 2px oklch(0.35 0.04 62 / 12%)',
    'shadow-2': '0 4px 16px oklch(0.35 0.04 62 / 14%)',
    'shadow-3': '0 12px 40px oklch(0.35 0.04 62 / 18%)',
  },
}

export const themes: Record<ThemeId, Theme> = {
  obsidian,
  graphite,
  nocturne,
  verdant,
  porcelain,
  sandstone,
}

/** Registry order for pickers: dark themes first, then light. */
export const themeList: readonly Theme[] = themeIds.map((id) => themes[id])

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (themeIds as readonly string[]).includes(value)
}

/** Resolves any stored value to a real theme, falling back to the default. */
export function themeOf(value: unknown): Theme {
  return themes[isThemeId(value) ? value : defaultThemeId]
}

/** The theme used when the user follows the OS color scheme. */
export function systemTheme(prefersDark: boolean): Theme {
  return prefersDark ? themes.obsidian : themes.porcelain
}

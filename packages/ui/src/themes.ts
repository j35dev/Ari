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
  'glass-scrim',
  'glass-overlay',
  'glass-input',
  'glass-hover',
  'glass-active',
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
  /** Whether the theme opts into translucent chrome (acrylic/vibrancy + blur). */
  glass: boolean
  colors: Record<ThemeColorRole, string>
}

export const defaultThemeId: ThemeId = 'obsidian'

const obsidian: Theme = {
  id: 'obsidian',
  label: 'Obsidian',
  description: 'Near-black glass with an indigo accent. Ari’s signature look.',
  scheme: 'dark',
  glass: true,
  colors: {
    bg: 'oklch(0.095 0.008 278)',
    'surface-0': 'oklch(0.12 0.011 278)',
    'surface-1': 'oklch(0.155 0.014 278)',
    'surface-2': 'oklch(0.21 0.018 278)',
    'surface-3': 'oklch(0.275 0.022 277)',
    border: 'oklch(0.85 0.02 278 / 11%)',
    'border-strong': 'oklch(0.86 0.025 278 / 18%)',
    'inner-stroke': 'oklch(0.9 0.015 278 / 5%)',
    fg: 'oklch(0.93 0.008 280)',
    'fg-muted': 'oklch(0.72 0.015 278)',
    'fg-subtle': 'oklch(0.59 0.02 278)',
    'fg-on-accent': 'oklch(0.985 0.002 280)',
    accent: 'oklch(0.665 0.19 279)',
    'accent-hover': 'oklch(0.72 0.175 280)',
    'accent-active': 'oklch(0.6 0.205 280)',
    'accent-subtle': 'oklch(0.665 0.19 279 / 14%)',
    'accent-ring': 'oklch(0.665 0.19 279 / 45%)',
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
    'glass-scrim': 'oklch(0.088 0.009 278 / 78%)',
    'glass-overlay': 'oklch(0.33 0.028 278 / 34%)',
    'glass-input': 'oklch(0.95 0.012 278 / 4.5%)',
    'glass-hover': 'oklch(0.93 0.012 278 / 9%)',
    'glass-active': 'oklch(0.93 0.012 278 / 14%)',
    'shadow-1': '0 1px 2px oklch(0 0 0 / 35%)',
    'shadow-2': '0 4px 16px oklch(0 0 0 / 40%)',
    'shadow-3': '0 12px 40px oklch(0 0 0 / 50%)',
  },
}

const graphite: Theme = {
  id: 'graphite',
  label: 'Graphite',
  description: 'Opaque warm charcoal with a warm amber accent. No blur.',
  scheme: 'dark',
  glass: false,
  colors: {
    bg: 'oklch(0.145 0.006 65)',
    'surface-0': 'oklch(0.185 0.007 65)',
    'surface-1': 'oklch(0.23 0.009 65)',
    'surface-2': 'oklch(0.28 0.011 65)',
    'surface-3': 'oklch(0.34 0.013 64)',
    border: 'oklch(0.92 0.015 70 / 9%)',
    'border-strong': 'oklch(0.92 0.02 70 / 16%)',
    'inner-stroke': 'oklch(0.93 0.012 70 / 5%)',
    fg: 'oklch(0.945 0.003 65)',
    'fg-muted': 'oklch(0.735 0.008 65)',
    'fg-subtle': 'oklch(0.61 0.01 65)',
    'fg-on-accent': 'oklch(0.17 0.02 70)',
    accent: 'oklch(0.8 0.15 78)',
    'accent-hover': 'oklch(0.845 0.14 80)',
    'accent-active': 'oklch(0.72 0.16 75)',
    'accent-subtle': 'oklch(0.8 0.15 78 / 16%)',
    'accent-ring': 'oklch(0.8 0.15 78 / 45%)',
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
    'glass-scrim': 'oklch(0.185 0.007 65)',
    'glass-overlay': 'oklch(0.28 0.011 65)',
    'glass-input': 'oklch(0.23 0.009 65)',
    'glass-hover': 'oklch(0.95 0.008 70 / 8%)',
    'glass-active': 'oklch(0.95 0.008 70 / 13%)',
    'shadow-1': '0 1px 2px oklch(0 0 0 / 40%)',
    'shadow-2': '0 4px 16px oklch(0 0 0 / 45%)',
    'shadow-3': '0 12px 40px oklch(0 0 0 / 55%)',
  },
}

const nocturne: Theme = {
  id: 'nocturne',
  label: 'Nocturne',
  description: 'Deep indigo night with a cyan accent and frosted chrome.',
  scheme: 'dark',
  glass: true,
  colors: {
    bg: 'oklch(0.13 0.032 271)',
    'surface-0': 'oklch(0.165 0.036 271)',
    'surface-1': 'oklch(0.205 0.04 270)',
    'surface-2': 'oklch(0.255 0.044 269)',
    'surface-3': 'oklch(0.315 0.048 268)',
    border: 'oklch(0.8 0.06 250 / 14%)',
    'border-strong': 'oklch(0.82 0.07 250 / 22%)',
    'inner-stroke': 'oklch(0.9 0.04 250 / 7%)',
    fg: 'oklch(0.945 0.012 260)',
    'fg-muted': 'oklch(0.755 0.028 258)',
    'fg-subtle': 'oklch(0.63 0.035 258)',
    'fg-on-accent': 'oklch(0.16 0.04 230)',
    accent: 'oklch(0.8 0.12 208)',
    'accent-hover': 'oklch(0.845 0.105 206)',
    'accent-active': 'oklch(0.73 0.13 210)',
    'accent-subtle': 'oklch(0.8 0.12 208 / 16%)',
    'accent-ring': 'oklch(0.8 0.12 208 / 48%)',
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
    'glass-scrim': 'oklch(0.13 0.032 271 / 76%)',
    'glass-overlay': 'oklch(0.32 0.05 268 / 32%)',
    'glass-input': 'oklch(0.9 0.04 250 / 6%)',
    'glass-hover': 'oklch(0.92 0.03 250 / 9%)',
    'glass-active': 'oklch(0.92 0.03 250 / 14%)',
    'shadow-1': '0 1px 2px oklch(0.05 0.03 270 / 45%)',
    'shadow-2': '0 4px 16px oklch(0.05 0.03 270 / 50%)',
    'shadow-3': '0 12px 40px oklch(0.04 0.03 270 / 60%)',
  },
}

const verdant: Theme = {
  id: 'verdant',
  label: 'Verdant',
  description: 'Dark moss surfaces with a lime accent. Opaque and low-glare.',
  scheme: 'dark',
  glass: false,
  colors: {
    bg: 'oklch(0.145 0.024 152)',
    'surface-0': 'oklch(0.18 0.027 152)',
    'surface-1': 'oklch(0.22 0.03 151)',
    'surface-2': 'oklch(0.27 0.034 150)',
    'surface-3': 'oklch(0.33 0.038 149)',
    border: 'oklch(0.88 0.045 150 / 13%)',
    'border-strong': 'oklch(0.9 0.05 150 / 22%)',
    'inner-stroke': 'oklch(0.92 0.03 150 / 6%)',
    fg: 'oklch(0.94 0.014 140)',
    'fg-muted': 'oklch(0.755 0.03 144)',
    'fg-subtle': 'oklch(0.63 0.035 147)',
    'fg-on-accent': 'oklch(0.17 0.05 135)',
    accent: 'oklch(0.8 0.16 131)',
    'accent-hover': 'oklch(0.845 0.145 129)',
    'accent-active': 'oklch(0.73 0.17 133)',
    'accent-subtle': 'oklch(0.8 0.16 131 / 16%)',
    'accent-ring': 'oklch(0.8 0.16 131 / 45%)',
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
    'glass-scrim': 'oklch(0.18 0.027 152)',
    'glass-overlay': 'oklch(0.27 0.034 150)',
    'glass-input': 'oklch(0.22 0.03 151)',
    'glass-hover': 'oklch(0.92 0.03 150 / 8%)',
    'glass-active': 'oklch(0.92 0.03 150 / 13%)',
    'shadow-1': '0 1px 2px oklch(0.05 0.02 150 / 42%)',
    'shadow-2': '0 4px 16px oklch(0.05 0.02 150 / 48%)',
    'shadow-3': '0 12px 40px oklch(0.04 0.02 150 / 58%)',
  },
}

const porcelain: Theme = {
  id: 'porcelain',
  label: 'Porcelain',
  description: 'Cool off-white paper with a soft violet accent.',
  scheme: 'light',
  glass: false,
  colors: {
    bg: 'oklch(0.985 0.003 285)',
    'surface-0': 'oklch(0.968 0.006 285)',
    'surface-1': 'oklch(0.945 0.008 285)',
    'surface-2': 'oklch(0.91 0.011 285)',
    'surface-3': 'oklch(0.868 0.014 285)',
    border: 'oklch(0.22 0.02 285 / 11%)',
    'border-strong': 'oklch(0.22 0.02 285 / 20%)',
    'inner-stroke': 'oklch(1 0 0 / 70%)',
    fg: 'oklch(0.24 0.018 285)',
    'fg-muted': 'oklch(0.475 0.02 285)',
    'fg-subtle': 'oklch(0.59 0.018 285)',
    'fg-on-accent': 'oklch(0.99 0.005 285)',
    accent: 'oklch(0.5 0.2 292)',
    'accent-hover': 'oklch(0.445 0.21 292)',
    'accent-active': 'oklch(0.39 0.19 292)',
    'accent-subtle': 'oklch(0.5 0.2 292 / 12%)',
    'accent-ring': 'oklch(0.5 0.2 292 / 38%)',
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
    'glass-scrim': 'oklch(0.99 0.003 285 / 82%)',
    'glass-overlay': 'oklch(1 0 0 / 78%)',
    'glass-input': 'oklch(1 0 0 / 72%)',
    'glass-hover': 'oklch(0.28 0.02 285 / 6%)',
    'glass-active': 'oklch(0.28 0.02 285 / 11%)',
    'shadow-1': '0 1px 2px oklch(0.3 0.02 285 / 10%)',
    'shadow-2': '0 4px 16px oklch(0.3 0.02 285 / 12%)',
    'shadow-3': '0 12px 40px oklch(0.3 0.02 285 / 16%)',
  },
}

const sandstone: Theme = {
  id: 'sandstone',
  label: 'Sandstone',
  description: 'Warm paper tones with a deep teal accent.',
  scheme: 'light',
  glass: false,
  colors: {
    bg: 'oklch(0.975 0.012 84)',
    'surface-0': 'oklch(0.955 0.017 82)',
    'surface-1': 'oklch(0.93 0.02 80)',
    'surface-2': 'oklch(0.895 0.024 78)',
    'surface-3': 'oklch(0.852 0.028 76)',
    border: 'oklch(0.3 0.03 70 / 13%)',
    'border-strong': 'oklch(0.3 0.03 70 / 22%)',
    'inner-stroke': 'oklch(1 0 0 / 65%)',
    fg: 'oklch(0.255 0.025 62)',
    'fg-muted': 'oklch(0.48 0.03 62)',
    'fg-subtle': 'oklch(0.59 0.028 62)',
    'fg-on-accent': 'oklch(0.985 0.01 180)',
    accent: 'oklch(0.47 0.105 197)',
    'accent-hover': 'oklch(0.41 0.11 197)',
    'accent-active': 'oklch(0.365 0.1 198)',
    'accent-subtle': 'oklch(0.47 0.105 197 / 14%)',
    'accent-ring': 'oklch(0.47 0.105 197 / 38%)',
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
    'glass-scrim': 'oklch(0.98 0.012 84 / 84%)',
    'glass-overlay': 'oklch(0.995 0.008 84 / 80%)',
    'glass-input': 'oklch(1 0.004 84 / 74%)',
    'glass-hover': 'oklch(0.3 0.03 62 / 7%)',
    'glass-active': 'oklch(0.3 0.03 62 / 12%)',
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

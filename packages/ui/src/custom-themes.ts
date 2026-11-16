import {
  customThemeSchema,
  type CustomTheme,
  type ThemePart,
  type ThemeVisualStyle,
} from '@ari/contracts/themes'
import { themeOf, type Theme } from './themes'
import { oklchToHex } from './color'
import { hexContrast } from '@ari/contracts/themes'

export const themePartSelectors: Record<ThemePart, string> = {
  app: 'body',
  frame: '.ari-frame',
  stage: '.ari-stage',
  sidebar: '[data-ari-part="sidebar"]',
  titlebar: '[data-ari-part="titlebar"]',
  panel: '[data-ari-part="panel"], .ari-theme-panel',
  widget: '.aria-pill',
  'dictation-indicator': '.dictation-indicator',
  composer: '.ari-composer-shell',
  'composer-input': '.ari-composer-field',
  transcript: '.ari-transcript-scroll',
  'user-message': '.ari-user-bubble',
  'assistant-message': '[data-ari-part="assistant-message"]',
  'tool-call': '[data-ari-part="tool-call"]',
  approval: '[data-ari-part="approval"]',
  notice: '[role="status"], [role="alert"]',
  button: 'button, [role="button"]',
  'primary-button': '.ari-theme-primary-button',
  'outline-button': '.ari-theme-outline-button',
  'icon-button': '.ari-theme-icon-button',
  icon: 'svg.lucide',
  input: 'input:not([type="checkbox"]):not([type="radio"])',
  textarea: 'textarea',
  select: 'select',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  switch: '[role="switch"]',
  tab: '[role="tab"], .ari-theme-tab',
  'list-row': '.ari-theme-row',
  menu: '[role="menu"], [role="listbox"], .ari-theme-menu',
  'menu-item': '[role="menuitem"], [role="option"], .ari-theme-menu-item',
  dialog: '[role="dialog"]',
  popover: '[data-ari-part="popover"]',
  tooltip: '[role="tooltip"]',
  toast: '[data-ari-part="toast"]',
  badge: '.ari-theme-badge',
  separator: 'hr, [role="separator"]',
  code: 'pre, code',
  link: 'a',
  heading: 'h1, h2, h3, h4, h5, h6',
  text: 'p',
  table: 'table',
  'table-header': 'th',
  'table-cell': 'td',
  'file-editor': '.ari-file-editor',
  diff: '.ari-diff-surface',
  terminal: '[data-ari-part="terminal"]',
  'settings-card': '.ari-theme-settings-card',
  'settings-row': '[data-ari-part="settings-row"]',
  'empty-state': '[data-ari-part="empty-state"]',
  skeleton: '[data-ari-part="skeleton"]',
  progress: 'progress, [role="progressbar"], [data-ari-part="progress"]',
  scrollbar: '.ari-scroll::-webkit-scrollbar-thumb',
}

const fonts = {
  geist: "'Geist Variable', sans-serif",
  manrope: "'Manrope Variable', sans-serif",
  'source-sans': "'Source Sans 3 Variable', sans-serif",
  'source-serif': "'Source Serif 4 Variable', serif",
  'geist-mono': "'Geist Mono Variable', monospace",
  'jetbrains-mono': "'JetBrains Mono Variable', monospace",
  'fira-code': "'Fira Code Variable', monospace",
} as const
const shadow = (value: NonNullable<ThemeVisualStyle['shadow']>) =>
  value.length
    ? value
        .map(
          (s) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`,
        )
        .join(',')
    : 'none'

/** Also validates inherited text against changed surfaces before installing. */
export function resolveCustomTheme(input: unknown): Theme {
  const manifest = customThemeSchema.parse(input)
  const base = themeOf(manifest.base)
  const colors = { ...base.colors, ...manifest.colors }
  const hex = (value: string) => (value.startsWith('#') ? value : oklchToHex(value)!)
  const flatten = (value: string, behind: string) => {
    const raw = hex(value)
    if (raw.length !== 9) return raw
    const alpha = parseInt(raw.slice(7), 16) / 255
    return (
      '#' +
      [1, 3, 5]
        .map((offset) =>
          Math.round(
            parseInt(raw.slice(offset, offset + 2), 16) * alpha +
              parseInt(hex(behind).slice(offset, offset + 2), 16) * (1 - alpha),
          )
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    )
  }
  for (const bg of ['bg', 'surface-0', 'surface-1', 'surface-2', 'surface-3'] as const) {
    for (const fg of ['fg', 'fg-muted', 'fg-subtle'] as const) {
      if (hexContrast(hex(colors[fg]), flatten(colors[bg], colors.bg)) < (fg === 'fg' ? 4.5 : 3))
        throw new Error(
          `${fg} on ${bg} needs at least ${fg === 'fg' ? '4.5' : '3'}:1 contrast. Adjust these palette colors.`,
        )
    }
  }
  for (const [part, overrides] of Object.entries(manifest.parts)) {
    for (const [state, style] of Object.entries(overrides)) {
      if (!style.color && !style.backgroundColor && !style.gradient) continue
      const fallback = overrides.default ?? {}
      const inverted = part === 'primary-button'
      const foreground = style.color ?? fallback.color ?? (inverted ? colors.bg : colors.fg)
      const background =
        style.backgroundColor ??
        fallback.backgroundColor ??
        (inverted ? colors.fg : colors['surface-1'])
      const gradient = style.gradient ?? fallback.gradient
      const candidates = gradient ? [gradient.from, gradient.to] : [background]
      for (const candidate of candidates) {
        if (hexContrast(hex(foreground), flatten(candidate, colors.bg)) < 4.5)
          throw new Error(
            `${part}.${state} needs at least 4.5:1 text contrast. Set a readable color and backgroundColor.`,
          )
      }
    }
  }
  return {
    ...base,
    id: manifest.id,
    label: manifest.name,
    description: manifest.description,
    colors,
  }
}

function declarations(style: ThemeVisualStyle): string {
  const entries: string[] = []
  const add = (key: string, value: string | number | undefined, unit = '') => {
    if (value !== undefined) entries.push(`${key}:${value}${unit} !important`)
  }
  add('color', style.color)
  add('background-color', style.backgroundColor)
  add('border-color', style.borderColor)
  add('border-width', style.borderWidth, 'px')
  add('border-style', style.borderStyle ?? (style.borderWidth !== undefined ? 'solid' : undefined))
  add('border-radius', style.borderRadius, 'px')
  add('font-family', style.font && fonts[style.font])
  add('font-size', style.fontSize, 'px')
  add('font-weight', style.fontWeight)
  add('letter-spacing', style.letterSpacing, 'px')
  add('line-height', style.lineHeight)
  add('stroke-width', style.strokeWidth)
  if (style.shadow) add('box-shadow', shadow(style.shadow))
  if (style.gradient)
    add(
      'background-image',
      `linear-gradient(${style.gradient.angle}deg,${style.gradient.from},${style.gradient.to})`,
    )
  return entries.join(';')
}

const states = {
  default: '',
  hover: ':hover:not(:disabled)',
  active: ':active:not(:disabled)',
  selected:
    ':is([aria-selected="true"],[aria-pressed="true"],[aria-checked="true"],[aria-current="page"],[data-state="active"],[data-state="checked"],.ari-theme-selected)',
  focus: ':focus-visible',
  disabled: ':is(:disabled,[aria-disabled="true"])',
} as const

/** Every selector and property is owned by Ari. User data cannot escape a rule. */
export function customThemeCss(input: unknown): string {
  const theme = customThemeSchema.parse(input)
  const scope = `html[data-ari-custom-theme="${theme.id}"]`
  const vars = Object.entries(resolveCustomTheme(theme).colors).map(
    ([role, color]) => `--ari-${role}:${color}`,
  )
  vars.push(`--spacing:${{ compact: 3.5, comfortable: 4, spacious: 4.5 }[theme.density]}px`)
  for (const [name, value] of Object.entries(theme.radii ?? {}))
    vars.push(`--ari-radius-${name}:${value}px`)
  if (theme.typography?.ui) vars.push(`--ari-font-ui:${fonts[theme.typography.ui]}`)
  if (theme.typography?.mono) vars.push(`--ari-font-mono:${fonts[theme.typography.mono]}`)
  for (const [name, value] of Object.entries(theme.shadows ?? {}))
    vars.push(`--ari-shadow-${name}:${shadow(value)}`)
  const rules = [`${scope}{${vars.join(';')}}`]
  for (const [part, overrides] of Object.entries(theme.parts)) {
    for (const [state, style] of Object.entries(overrides)) {
      const selector = themePartSelectors[part as ThemePart]
      const suffix = states[state as keyof typeof states]
      // Pseudo-elements need their exclusion and state on the owning element.
      const target =
        part === 'scrollbar'
          ? `.ari-scroll:not([data-ari-theme-recovery] *)${suffix}::-webkit-scrollbar-thumb`
          : `:is(${selector}):not([data-ari-theme-recovery],[data-ari-theme-recovery] *)${suffix}`
      rules.push(`${scope} ${target}{${declarations(style)}}`)
    }
  }
  if (theme.scene === 'none') rules.push(`${scope} .ari-scene{visibility:hidden}`)
  // Preserve a visible keyboard focus indicator even in highly decorated themes.
  rules.push(
    `${scope} :is(button,input,textarea,select,a,[tabindex]):not([data-ari-theme-recovery] *):focus-visible{outline:2px solid var(--ari-fg) !important;outline-offset:2px !important;box-shadow:0 0 0 4px var(--ari-bg) !important}`,
  )
  return rules.join('\n')
}

const STYLE_ID = 'ari-custom-theme-style'
export function paintCustomTheme(manifest: CustomTheme | undefined): void {
  if (!manifest) {
    delete document.documentElement.dataset['ariCustomTheme']
    document.getElementById(STYLE_ID)?.remove()
    return
  }
  const css = customThemeCss(manifest)
  let element = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = STYLE_ID
    document.head.append(element)
  }
  element.textContent = css
  document.documentElement.dataset['ariCustomTheme'] = manifest.id
}

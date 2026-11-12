/**
 * Shared class maps for the button family (Button, IconButton).
 * Token-based utilities only — raw color literals live exclusively in
 * tokens.css.
 */

export const BUTTON_BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-md text-[13px] font-medium ari-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50'

/**
 * Ink is the primary action: `primary` is the foreground colour, not the
 * accent. Hover is a wash of the foreground so it reads the same on chrome
 * and on the stage in every theme.
 */
export const BUTTON_VARIANT_CLASSES = {
  primary: 'bg-fg text-bg hover:bg-fg/90',
  secondary: 'border border-border-strong bg-transparent text-fg hover:bg-fg/6',
  ghost: 'bg-transparent text-fg-muted hover:bg-fg/6 hover:text-fg',
  danger: 'bg-danger text-fg-on-accent hover:bg-danger-hover',
} as const

export const BUTTON_SIZE_CLASSES = {
  sm: 'h-7 px-2.5',
  md: 'h-8 px-3',
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANT_CLASSES
export type ButtonSize = keyof typeof BUTTON_SIZE_CLASSES

export function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * Shared class maps for the button family (Button, IconButton).
 * Token-based utilities only — raw color literals live exclusively in
 * tokens.css (AGENTS.md).
 */

export const BUTTON_BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50'

export const BUTTON_VARIANT_CLASSES = {
  primary: 'bg-accent text-fg-on-accent hover:bg-accent-hover active:bg-accent-active',
  secondary: 'bg-surface-2 text-fg border border-border hover:bg-surface-3',
  ghost: 'bg-transparent hover:bg-surface-2',
  danger: 'bg-danger text-fg-on-accent hover:bg-danger-hover',
} as const

export const BUTTON_SIZE_CLASSES = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
} as const

export type ButtonVariant = keyof typeof BUTTON_VARIANT_CLASSES
export type ButtonSize = keyof typeof BUTTON_SIZE_CLASSES

export function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

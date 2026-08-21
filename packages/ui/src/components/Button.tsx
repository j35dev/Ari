import type { ComponentProps } from 'react'
import {
  BUTTON_BASE_CLASSES,
  BUTTON_SIZE_CLASSES,
  BUTTON_VARIANT_CLASSES,
  joinClasses,
  type ButtonSize,
  type ButtonVariant,
} from './button-styles'

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows an inline spinner, sets `aria-busy`, and blocks pointer events. */
  loading?: boolean
  /** Renders a muted mono shortcut chip pinned to the right edge. */
  shortcut?: string
}

/**
 * Action primitive. Variants and sizes resolve to Ari design tokens so they
 * follow the active theme.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  shortcut,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      aria-busy={loading || undefined}
      className={joinClasses(
        BUTTON_BASE_CLASSES,
        BUTTON_VARIANT_CLASSES[variant],
        BUTTON_SIZE_CLASSES[size],
        loading && 'pointer-events-none',
        className,
      )}
      disabled={disabled}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
      {shortcut && (
        <kbd className="ml-auto rounded-sm border border-border bg-surface-1 px-1.5 py-0.5 font-mono text-xs font-normal text-fg-muted">
          {shortcut}
        </kbd>
      )}
    </button>
  )
}

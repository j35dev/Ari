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
          className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        />
      )}
      {children}
      {shortcut && (
        // Drawn in the button's own text colour so it reads on every variant.
        <kbd className="ml-auto inline-flex h-5 items-center rounded-[5px] border border-current/25 px-1.5 font-mono text-[11px] font-normal opacity-70">
          {shortcut}
        </kbd>
      )}
    </button>
  )
}

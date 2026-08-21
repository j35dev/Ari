import type { ComponentProps, ReactNode } from 'react'
import {
  BUTTON_BASE_CLASSES,
  BUTTON_VARIANT_CLASSES,
  joinClasses,
  type ButtonSize,
  type ButtonVariant,
} from './button-styles'

const ICON_BUTTON_SIZE_CLASSES = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
} as const

export type IconButtonProps = Omit<ComponentProps<'button'>, 'children'> & {
  icon: ReactNode
  /** Required accessible name — icon-only buttons have no visible text. */
  'aria-label': string
  variant?: ButtonVariant
  size?: ButtonSize
}

/** Square icon-only action primitive; same variants as {@link Button}. */
export function IconButton({
  icon,
  variant = 'secondary',
  size = 'md',
  'aria-label': ariaLabel,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      aria-label={ariaLabel}
      className={joinClasses(
        BUTTON_BASE_CLASSES,
        BUTTON_VARIANT_CLASSES[variant],
        ICON_BUTTON_SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  )
}

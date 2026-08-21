import type { HTMLAttributes } from 'react'

export type SpinnerSize = 'sm' | 'md' | 'lg'

const SPINNER_SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-7',
}

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize
}

/**
 * Indeterminate activity indicator. Color inherits the current text color;
 * rotation is dropped entirely under prefers-reduced-motion.
 */
export function Spinner({ size = 'md', className, ...rest }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={[
        'inline-block rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin',
        SPINNER_SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
}

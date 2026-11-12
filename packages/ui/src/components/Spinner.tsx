import type { HTMLAttributes } from 'react'

export type SpinnerSize = 'sm' | 'md' | 'lg'

const SPINNER_SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'size-4 border-[1.5px]',
  md: 'size-5 border-[1.5px]',
  lg: 'size-7 border-2',
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
        'inline-block rounded-full border-current border-t-transparent motion-safe:animate-spin',
        SPINNER_SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
}

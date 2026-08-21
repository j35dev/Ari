import type { HTMLAttributes } from 'react'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Fixed width; numbers are treated as px. Omit to size via className. */
  w?: number | string
  /** Fixed height; numbers are treated as px. Omit to size via className. */
  h?: number | string
}

/**
 * Loading placeholder that pulses via the shared `ari-pulse` keyframes.
 * Hidden from assistive technology — announce loading state separately.
 */
export function Skeleton({ w, h, className, style, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={['ari-pulse rounded-md bg-surface-2', className]
        .filter(Boolean)
        .join(' ')}
      style={{ width: w, height: h, ...style }}
      {...rest}
    />
  )
}

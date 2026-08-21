import type { HTMLAttributes, ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type BadgeSize = 'sm' | 'md'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-fg-muted',
  accent: 'bg-accent-subtle text-fg',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
}

const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: 'px-1 py-px',
  md: 'px-1.5 py-0.5',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  size?: BadgeSize
  children: ReactNode
}

/** Compact status label; each tone pairs a subtle background with a readable foreground token. */
export function Badge({ tone = 'neutral', size = 'md', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-sm font-medium uppercase tracking-wide text-2xs',
        TONE_CLASSES[tone],
        SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </span>
  )
}

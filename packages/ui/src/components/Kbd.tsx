import type { HTMLAttributes } from 'react'

export type KbdProps = HTMLAttributes<HTMLElement>

/** Keyboard-key hint rendered as a small mono-spaced chip. */
export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd
      className={[
        'inline-flex h-5 items-center rounded-sm border border-border bg-surface-2 px-1.5 font-mono text-2xs text-fg-muted',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </kbd>
  )
}

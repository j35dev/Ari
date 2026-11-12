import type { HTMLAttributes } from 'react'

export type KbdProps = HTMLAttributes<HTMLElement>

/** Keyboard-key hint rendered as a small mono-spaced chip. */
export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd
      className={[
        'inline-flex h-5 items-center rounded-[5px] border border-border px-1.5 font-mono text-[11px] text-fg-subtle',
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

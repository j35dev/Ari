import { useEffect, useRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Show the mixed state (dash instead of checkmark). */
  indeterminate?: boolean
  /** Optional label text rendered beside the box. */
  children?: ReactNode
}

/** Styled checkbox built on a visually-hidden native input for full form semantics. */
export function Checkbox({ indeterminate = false, className, children, ...rest }: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label
      className={['inline-flex cursor-pointer items-center gap-2 select-none', className]
        .filter(Boolean)
        .join(' ')}
    >
      <input ref={inputRef} type="checkbox" className="peer sr-only" {...rest} />
      <span
        className={[
          'flex h-4 w-4 items-center justify-center rounded-sm border border-border-strong bg-surface-1 transition-colors',
          indeterminate
            ? 'peer-indeterminate:border-accent peer-indeterminate:bg-accent peer-indeterminate:[&>svg]:opacity-100'
            : 'peer-checked:border-accent peer-checked:bg-accent peer-checked:[&>svg]:opacity-100',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
        ].join(' ')}
      >
        {indeterminate ? (
          <svg
            data-testid="checkbox-dash"
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="h-3 w-3 text-fg-on-accent opacity-0"
          >
            <path d="M2.5 6h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            data-testid="checkbox-check"
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="h-3 w-3 text-fg-on-accent opacity-0"
          >
            <path
              d="M2.5 6.5 5 9l4.5-5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {children != null && <span className="text-sm text-fg">{children}</span>}
    </label>
  )
}

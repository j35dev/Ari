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
          'flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-border-strong transition-colors',
          indeterminate
            ? 'peer-indeterminate:border-fg peer-indeterminate:bg-fg peer-indeterminate:[&>svg]:opacity-100'
            : 'peer-checked:border-fg peer-checked:bg-fg peer-checked:[&>svg]:opacity-100',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-accent-ring',
          'peer-disabled:opacity-50',
        ].join(' ')}
      >
        {indeterminate ? (
          <svg
            data-testid="checkbox-dash"
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="h-3 w-3 text-bg opacity-0"
          >
            <path
              d="M2.5 6h7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg
            data-testid="checkbox-check"
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="h-3 w-3 text-bg opacity-0"
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
      {children != null && <span className="text-[13px] text-fg">{children}</span>}
    </label>
  )
}

import type { ComponentProps, ReactNode } from 'react'

export interface InputProps extends ComponentProps<'input'> {
  invalid?: boolean
  leading?: ReactNode
  trailing?: ReactNode
}

/**
 * Single-line text control. The visible box is a surface wrapper holding
 * optional leading/trailing slots around the input; the focus ring lives on
 * the wrapper via focus-within. `ref` and all native input props forward to
 * the underlying <input>; `className` styles the wrapper.
 */
export function Input({ invalid = false, leading, trailing, className, ref, ...rest }: InputProps) {
  const wrapperClass = [
    'flex h-8 items-center gap-1.5 rounded-md border bg-surface-1 px-2.5 text-[13px]',
    'transition-[border-color,box-shadow] focus-within:ring-2',
    invalid
      ? 'border-danger focus-within:ring-danger/40'
      : 'border-border hover:border-border-strong focus-within:border-border-strong focus-within:ring-accent-ring',
    className,
  ]
    .filter((v): v is string => v != null)
    .join(' ')

  return (
    <div className={wrapperClass}>
      {leading != null && (
        <span className="flex shrink-0 items-center text-fg-subtle">{leading}</span>
      )}
      <input
        {...rest}
        ref={ref}
        aria-invalid={invalid || rest['aria-invalid'] || undefined}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
      />
      {trailing != null && (
        <span className="flex shrink-0 items-center text-fg-subtle">{trailing}</span>
      )}
    </div>
  )
}

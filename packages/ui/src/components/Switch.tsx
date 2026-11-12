import { useState } from 'react'
import type { ButtonHTMLAttributes } from 'react'

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'checked' | 'defaultChecked' | 'onChange'
> {
  /** Controlled on-state; provide together with onCheckedChange. */
  checked?: boolean
  /** Initial on-state for uncontrolled usage. */
  defaultChecked?: boolean
  /** Called with the next state after a user toggle. */
  onCheckedChange?: (checked: boolean) => void
}

/** Toggle control exposing role="switch"; works controlled or uncontrolled. */
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  className,
  type,
  ...rest
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked)
  const isControlled = checked !== undefined
  const on = isControlled ? checked : internal

  const handleClick = () => {
    const next = !on
    if (!isControlled) setInternal(next)
    onCheckedChange?.(next)
  }

  return (
    <button
      type={type ?? 'button'}
      role="switch"
      aria-checked={on}
      onClick={handleClick}
      className={[
        'relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full px-0.5 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Ink, not the accent. The thumb is the stage colour in both states,
        // so only the track changes: a wash when off, solid ink when on.
        on ? 'bg-fg' : 'bg-fg/20',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <span
        className={[
          'pointer-events-none block size-4 rounded-full bg-bg transition-transform duration-200',
          on ? 'translate-x-3.5' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  )
}

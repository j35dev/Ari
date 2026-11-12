import { useId, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { motion } from 'motion/react'

export interface SegmentedOption {
  /** Unique value for the option. */
  value: string
  /** Option label content. */
  label: ReactNode
}

export interface SegmentedControlProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Options to render, in order. */
  options: SegmentedOption[]
  /** Controlled selected value; provide together with onChange. */
  value?: string
  /** Initially selected value for uncontrolled usage. */
  defaultValue?: string
  /** Called with the newly selected value. */
  onChange?: (value: string) => void
  /** Density of the control. */
  size?: 'sm' | 'md'
}

/**
 * Single-select pill group with a sliding thumb: the selected option's
 * background moves between options via a shared motion layoutId.
 */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onChange,
  size = 'md',
  className,
  ...rest
}: SegmentedControlProps) {
  const [internal, setInternal] = useState(defaultValue ?? '')
  const isControlled = value !== undefined
  const current = isControlled ? value : internal
  const thumbId = `${useId().replace(/\W/g, '')}-thumb`

  const select = (next: string) => {
    if (!isControlled) setInternal(next)
    onChange?.(next)
  }

  return (
    <div
      className={['inline-flex items-center rounded-lg bg-surface-2 p-[3px]', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {options.map((option) => {
        const selected = option.value === current
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => select(option.value)}
            className={[
              'relative inline-flex items-center justify-center whitespace-nowrap rounded-md text-[13px] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
              size === 'sm' ? 'h-6 px-2.5' : 'h-7 px-3',
              selected ? 'text-fg' : 'text-fg-subtle hover:text-fg',
            ].join(' ')}
          >
            {selected && (
              <motion.span
                layoutId={thumbId}
                data-thumb=""
                aria-hidden
                className="absolute inset-0 rounded-md bg-bg shadow-1"
                transition={{ duration: 0.2, ease: 'easeOut' }}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

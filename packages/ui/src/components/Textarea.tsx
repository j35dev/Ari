import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ChangeEvent } from 'react'
import type { ComponentProps } from 'react'

export interface TextareaProps extends ComponentProps<'textarea'> {
  /** Grow vertically with content, clamped between 3 and 10 rows. */
  autoGrow?: boolean
}

const MIN_ROWS = 3
const MAX_ROWS = 10

/** Clamp content height to the [MIN_ROWS, MAX_ROWS] band (plus vertical padding). */
export function autoGrowHeight(
  scrollHeight: number,
  lineHeight: number,
  padY: number,
): number {
  const min = lineHeight * MIN_ROWS + padY
  const max = lineHeight * MAX_ROWS + padY
  return Math.min(Math.max(scrollHeight, min), max)
}

/**
 * Multi-line text control. With `autoGrow`, height tracks content via
 * scrollHeight on mount and every input, capped at ~10 rows with overflow
 * scroll beyond; `ref` and all native textarea props forward through.
 */
export function Textarea({
  autoGrow = false,
  className,
  onChange,
  ref,
  rows,
  value,
  ...rest
}: TextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  const resize = useCallback(() => {
    const el = innerRef.current
    if (!el) return
    const cs = window.getComputedStyle(el)
    const lineHeight = Number.parseFloat(cs.lineHeight)
    const padY =
      Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom)
    if (!Number.isFinite(lineHeight) || !Number.isFinite(padY)) return

    el.style.overflowY = 'hidden'
    el.style.height = 'auto'
    const content = el.scrollHeight
    el.style.height = `${autoGrowHeight(content, lineHeight, padY)}px`
    el.style.overflowY = content > lineHeight * MAX_ROWS + padY ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    if (autoGrow) resize()
  }, [autoGrow, resize, value])

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) ref.current = el
    },
    [ref],
  )

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(e)
      if (autoGrow) resize()
    },
    [autoGrow, onChange, resize],
  )

  const controlClass = [
    'w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5',
    'text-fg outline-none placeholder:text-fg-subtle',
    'focus:ring-2 focus:ring-accent-ring',
    'disabled:cursor-not-allowed disabled:opacity-50',
    autoGrow ? 'resize-none' : null,
    className,
  ]
    .filter((v): v is string => v != null)
    .join(' ')

  return (
    <textarea
      {...rest}
      ref={setRefs}
      className={controlClass}
      onChange={handleChange}
      rows={rows ?? (autoGrow ? MIN_ROWS : undefined)}
      value={value}
    />
  )
}

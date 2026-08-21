import { useId } from 'react'
import type { ReactNode } from 'react'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

export interface FieldProps {
  label: string
  hint?: string
  error?: string
  children: (controlProps: FieldControlProps) => ReactNode
}

/**
 * Labeled form field wrapper. Generates a stable control id, associates the
 * label via htmlFor, and wires hint/error into aria-describedby (error also
 * sets aria-invalid). Spread `controlProps` onto the control inside.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  const describedBy =
    [hint != null ? hintId : null, error != null ? errorId : null]
      .filter((v): v is string => v != null)
      .join(' ') || undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-fg" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error != null ? true : undefined,
      })}
      {hint != null && (
        <p className="text-xs text-fg-muted" id={hintId}>
          {hint}
        </p>
      )}
      {error != null && (
        <p className="text-xs text-danger" id={errorId}>
          {error}
        </p>
      )}
    </div>
  )
}

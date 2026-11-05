import type { ReactNode } from 'react'

export interface SettingsRowProps {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  className?: string
}

/** One row inside a settings card: copy on the left, control on the right. */
export function SettingsRow({ label, hint, children, className }: SettingsRowProps) {
  return (
    <div
      className={['flex min-h-14 items-center justify-between gap-6 px-4 py-3', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="min-w-0 max-w-lg">
        <p className="text-sm font-medium text-fg">{label}</p>
        {hint != null && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{hint}</p>}
      </div>
      {children != null && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

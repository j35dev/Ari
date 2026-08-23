import type { ReactNode } from 'react'

export interface SettingsRowProps {
  label: string
  hint: string
  children?: ReactNode
}

/** T3-style setting row: copy on the left, control on the right. */
export function SettingsRow({ label, hint, children }: SettingsRowProps) {
  return (
    <div className="flex items-start justify-between gap-8 border-b border-border/60 py-3.5 last:border-b-0">
      <div className="min-w-0 max-w-lg">
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{hint}</p>
      </div>
      {children ? <div className="flex shrink-0 items-center pt-0.5">{children}</div> : null}
    </div>
  )
}

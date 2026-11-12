import type { ReactNode } from 'react'
import { SETTINGS_HINT_CLASS, SETTINGS_LABEL_CLASS } from './SettingsSection'

export interface SettingsRowProps {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  className?: string
}

/** Padding and alignment of one row in a settings card. */
export const SETTINGS_ROW_CLASS = 'flex items-center justify-between gap-4 px-4 py-3.5'

/** One row inside a settings card: copy on the left, control on the right. */
export function SettingsRow({ label, hint, children, className }: SettingsRowProps) {
  return (
    <div className={[SETTINGS_ROW_CLASS, className].filter(Boolean).join(' ')}>
      <div className="min-w-0 max-w-lg flex-1">
        <p className={SETTINGS_LABEL_CLASS}>{label}</p>
        {hint != null && <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>{hint}</p>}
      </div>
      {children != null && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

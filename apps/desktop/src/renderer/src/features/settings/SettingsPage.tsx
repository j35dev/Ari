import type { ReactNode } from 'react'

export interface SettingsPageProps {
  /** Page title rendered as the section heading. */
  title: string
  /** One-line explanation shown under the title. */
  description?: string
  /** Page body sections. */
  children: ReactNode
  /** Extra classes on the wrapping column (e.g. tighter padding in the overlay). */
  className?: string
}

/** Shared settings layout: centered column with a titled, described header. */
export function SettingsPage({ title, description, children, className }: SettingsPageProps) {
  return (
    <div
      id={`settings-${title.toLowerCase()}`}
      className={['mx-auto max-w-2xl space-y-8 p-8', className].filter(Boolean).join(' ')}
    >
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        {description != null && <p className="text-sm text-fg-muted">{description}</p>}
      </div>
      {children}
    </div>
  )
}

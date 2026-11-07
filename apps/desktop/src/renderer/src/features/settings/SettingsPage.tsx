import type { ReactNode } from 'react'

export interface SettingsPageProps {
  /** Page title rendered as the section heading. */
  title: string
  /** One-line explanation shown under the title. */
  description?: string
  /** Page-level action shown at the top right, e.g. a rescan button. */
  actions?: ReactNode
  /** Search jump target. Defaults to `settings-<title slug>`. */
  id?: string
  /** Wider column for pages with side-by-side panes. */
  wide?: boolean
  /** Page body sections. */
  children: ReactNode
  /** Extra classes on the wrapping column. */
  className?: string
}

export function settingsPageId(title: string): string {
  return `settings-${title.toLowerCase().replace(/\s+/g, '-')}`
}

/** Shared settings layout: one centered column, a titled header, then sections. */
export function SettingsPage({
  title,
  description,
  actions,
  id,
  wide = false,
  children,
  className,
}: SettingsPageProps) {
  return (
    <div
      id={id ?? settingsPageId(title)}
      className={[
        'ari-settings-page mx-auto w-full px-8 pb-16 pt-9',
        wide ? 'max-w-4xl' : 'max-w-3xl',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="mb-8 flex items-start justify-between gap-6 px-1">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {description != null && (
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-fg-muted">{description}</p>
          )}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-9">{children}</div>
    </div>
  )
}

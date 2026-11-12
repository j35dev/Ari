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

/**
 * The page column: 680px of content (plus its gutters), 44px from the top of
 * the stage. `wide` is for pages with side-by-side panes.
 */
export const SETTINGS_COLUMN_CLASS = 'mx-auto w-full max-w-[744px] px-8 pb-16 pt-11'
export const SETTINGS_COLUMN_WIDE_CLASS = 'mx-auto w-full max-w-[984px] px-8 pb-16 pt-11'

/** Page title: 24px, semibold, tightened. */
export const SETTINGS_TITLE_CLASS = 'text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg'

/** The one-line description under a page title. */
export const SETTINGS_LEAD_CLASS = 'mt-1 text-sm text-fg-subtle'

/** Shared settings layout: one centered column, a title, a line, then groups. */
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
        'ari-settings-page',
        wide ? SETTINGS_COLUMN_WIDE_CLASS : SETTINGS_COLUMN_CLASS,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="mb-[30px] flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className={SETTINGS_TITLE_CLASS}>{title}</h1>
          {description != null && <p className={SETTINGS_LEAD_CLASS}>{description}</p>}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-[26px]">{children}</div>
    </div>
  )
}

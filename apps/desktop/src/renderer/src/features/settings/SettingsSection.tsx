import { useId } from 'react'
import type { ReactNode } from 'react'

/** Rounded surface that holds settings rows, divided by hairlines. */
export const SETTINGS_CARD_CLASS =
  'rounded-xl border border-border bg-surface-1 divide-y divide-border'

/** The caption above a group: 13px, medium, quiet. */
export const SETTINGS_CAPTION_CLASS = 'text-[13px] font-medium text-fg-subtle'

/** Secondary copy inside settings: row descriptions, notes, empty states. */
export const SETTINGS_HINT_CLASS = 'text-[13px] leading-5 text-fg-subtle'

/** A row's label. */
export const SETTINGS_LABEL_CLASS = 'text-sm font-medium text-fg'

/** A text field or native select in the settings language. */
export const SETTINGS_FIELD_CLASS =
  'h-8 max-w-full rounded-md border border-border bg-surface-1 px-2.5 text-[13px] text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50'

export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={[SETTINGS_CARD_CLASS, className].filter(Boolean).join(' ')}>{children}</div>
  )
}

export interface SettingsSectionProps {
  title: ReactNode
  description?: ReactNode
  /** Small control beside the heading, e.g. a refresh button. */
  action?: ReactNode
  /** Heading id, for callers that reference it elsewhere. */
  headingId?: string
  /** Skip the card when the body brings its own layout (grids, previews). */
  bare?: boolean
  children: ReactNode
  className?: string
}

/** A caption, an optional one-line description, then a card of rows. */
export function SettingsSection({
  title,
  description,
  action,
  headingId,
  bare = false,
  children,
  className,
}: SettingsSectionProps) {
  const fallbackId = useId()
  const id = headingId ?? fallbackId
  return (
    <section aria-labelledby={id} className={className}>
      <div className="mb-2.5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id={id} className={SETTINGS_CAPTION_CLASS}>
            {title}
          </h2>
          {description != null && <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>{description}</p>}
        </div>
        {action != null && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      {bare ? children : <SettingsCard>{children}</SettingsCard>}
    </section>
  )
}

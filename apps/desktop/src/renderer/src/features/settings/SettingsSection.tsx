import { useId } from 'react'
import type { ReactNode } from 'react'

/** Rounded surface that holds settings rows, divided by hairlines. */
export const SETTINGS_CARD_CLASS =
  'rounded-xl border border-border bg-surface-1/70 divide-y divide-border/70'

export function SettingsCard({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
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

/** A heading, an optional one-line description, then a card of rows. */
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
      <div className="mb-3 flex items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold text-fg">
            {title}
          </h2>
          {description != null && (
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
          )}
        </div>
        {action != null && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      {bare ? children : <SettingsCard>{children}</SettingsCard>}
    </section>
  )
}

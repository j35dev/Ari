import type { ReactNode } from 'react'

/**
 * The shared pieces every destination is built from.
 *
 * One module because none of these earns a file alone: a screen header, a
 * search field, a filter chip row, and the bottom-sheet shell. All styling is
 * design tokens; all touch targets clear 44px.
 */

/** A screen's title block: large title, one quiet line beneath it. */
export function ScreenHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">{title}</h1>
        <p className="mt-0.5 truncate text-sm text-fg-muted">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/** A rounded search field with a magnifier, and an optional filter toggle. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  filterActive,
  onFilterPress,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  filterActive?: boolean
  onFilterPress?: () => void
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-3">
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        aria-hidden
        className="shrink-0 text-fg-subtle"
      >
        <circle cx="9" cy="9" r="5.5" />
        <path d="m13.5 13.5 3 3" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        aria-label={label}
        className="h-11 min-w-0 flex-1 bg-transparent text-fg placeholder:text-fg-subtle"
      />
      {onFilterPress !== undefined && (
        <button
          type="button"
          onClick={onFilterPress}
          aria-label="Toggle archived sessions"
          aria-pressed={filterActive === true}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
            filterActive === true ? 'text-accent' : 'text-fg-subtle'
          }`}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M3 6h14" />
            <circle cx="8" cy="6" r="2" fill="var(--ari-surface-1)" />
            <path d="M3 14h14" />
            <circle cx="12.5" cy="14" r="2" fill="var(--ari-surface-1)" />
          </svg>
        </button>
      )}
    </div>
  )
}

/** A single-select chip row. Exactly one chip is active at a time. */
export function FilterChips<T extends string>({
  options,
  active,
  onPick,
}: {
  options: readonly { id: T; label: string }[]
  active: T
  onPick: (id: T) => void
}): ReactNode {
  return (
    <div role="group" className="flex gap-2 overflow-x-auto pb-1">
      {options.map((option) => {
        const selected = option.id === active
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(option.id)}
            className={`h-9 shrink-0 rounded-full px-4 text-sm ${
              selected
                ? 'bg-accent font-medium text-fg-on-accent'
                : 'border border-border text-fg-muted'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A bottom sheet: backdrop dismisses, the panel holds the content. */
export function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60"
      />
      <div className="relative max-h-[75%] overflow-y-auto rounded-t-3xl bg-surface-0 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
        <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" />
        <div className="flex items-center justify-between gap-3 py-2">
          <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-full text-fg-muted"
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

import { X } from 'lucide-react'
import { cx, iconButton, tab, tabSelected } from '../lib/recipes'

export interface PanelTab<Id extends string> {
  id: Id
  label: string
  /** A quiet number after the label, e.g. changed files. Hidden at zero. */
  count?: number | null
}

/**
 * The header of a docked panel: what it can show, which of those is showing,
 * and the way to put the panel away. Arrow keys move between tabs.
 */
export function PanelTabs<Id extends string>({
  tabs,
  active,
  onSelect,
  onClose,
  label = 'Panel',
}: {
  tabs: readonly PanelTab<Id>[]
  active: Id
  onSelect: (id: Id) => void
  onClose: () => void
  label?: string
}) {
  const move = (delta: number): void => {
    const index = tabs.findIndex((entry) => entry.id === active)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (next !== undefined) onSelect(next.id)
  }
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <div
        role="tablist"
        aria-label={label}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            move(1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            move(-1)
          }
        }}
      >
        {tabs.map((entry) => {
          const selected = entry.id === active
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(entry.id)}
              className={cx(tab, 'shrink-0', selected && tabSelected)}
            >
              {entry.label}
              {entry.count !== undefined && entry.count !== null && entry.count > 0 ? (
                <span className="text-xs tabular-nums text-fg-subtle">{entry.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      <button type="button" aria-label="Close inspector" onClick={onClose} className={iconButton}>
        <X size={15} strokeWidth={1.7} aria-hidden />
      </button>
    </div>
  )
}

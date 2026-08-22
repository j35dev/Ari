import { SquarePen } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'

/** Sidebar top: wordmark + one-click new session. */
export function SidebarHeader({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 pb-2 pt-3">
      <span className="text-xs font-semibold tracking-[0.18em] text-fg">ARI</span>
      <button
        type="button"
        aria-label="New session"
        onClick={onNewSession}
        className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <SquarePen size={13} />
      </button>
    </div>
  )
}

/** Primary sessions list, grouped visually recency-first. */
export function SessionsList({
  sessions,
  activeSessionId,
  onSelect,
}: {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2">
      {sessions.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">
          No sessions yet.
          <br />
          Start one with the ✎ button.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className={`w-full rounded-md px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                    isActive
                      ? 'bg-surface-2 text-fg'
                      : 'text-fg-muted hover:bg-surface-1 hover:text-fg'
                  }`}
                >
                  <span className="block truncate text-sm">{s.title}</span>
                  <span className="block truncate text-2xs text-fg-subtle">
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export interface UtilityItem {
  id: string
  label: string
  icon: LucideIcon
}

/** Sidebar bottom strip — switches the main pane without leaving the sidebar. */
export function UtilityStrip({
  active,
  onSelect,
  items,
}: {
  active: string
  onSelect: (id: string) => void
  items: UtilityItem[]
}) {
  return (
    <div className="flex items-center justify-around border-t border-border p-1.5">
      {items.map(({ id, label, icon: Icon }) => {
        const isActive = active === id
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => onSelect(id)}
            className={`flex h-7 w-9 items-center justify-center rounded-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
              isActive ? 'bg-accent-subtle text-accent' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Icon size={14} strokeWidth={isActive ? 2.2 : 1.8} />
          </button>
        )
      })}
    </div>
  )
}

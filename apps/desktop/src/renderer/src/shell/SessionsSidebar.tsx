import { motion } from 'motion/react'
import { sidebarSpring } from '@ari/ui/motion'
import { Search, SquarePen, Archive } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'

/**
 * Collapsible sessions sidebar. Width animates on a spring; content
 * crossfades so text never squishes (PLAN §6.4 sidebar-collapse).
 */
export function SessionsSidebar({
  open,
  sessions,
  activeSessionId,
  onToggle,
  onSelectSession,
  onNewSession,
}: {
  open: boolean
  sessions: SessionSummary[]
  activeSessionId: string | null
  onToggle: () => void
  onSelectSession: (id: string) => void
  onNewSession: () => void
}) {
  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? 'var(--ari-sidebar-width)' : 0 }}
      transition={sidebarSpring}
      className="relative shrink-0 overflow-hidden border-r border-border bg-surface-0"
    >
      <div className="flex h-full w-[var(--ari-sidebar-width)] flex-col">
        <div className="flex items-center gap-1 px-3 pb-2 pt-3">
          <span className="text-2xs font-semibold uppercase tracking-widest text-fg-subtle">
            Sessions
          </span>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Search sessions"
            className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Search size={13} />
          </button>
          <button
            type="button"
            aria-label="New session"
            onClick={onNewSession}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <SquarePen size={13} />
          </button>
        </div>

        <div className="ari-scroll flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-fg-subtle">
              No sessions yet.
              <br />
              Start one with the + button.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((s) => {
                const isActive = s.id === activeSessionId
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onSelectSession(s.id)}
                      className={`w-full rounded-md px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                        isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-1 hover:text-fg'
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

        <div className="border-t border-border p-2">
          <button
            type="button"
            aria-label="Archived sessions"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg"
          >
            <Archive size={13} /> Archived
          </button>
        </div>

        <button
          type="button"
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={onToggle}
          className="absolute -right-px top-1/2 z-10 hidden h-14 w-1 -translate-y-1/2 rounded-full bg-border-strong opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100 md:block"
        />
      </div>
    </motion.aside>
  )
}

import { useState } from 'react'
import { ChevronRight, FolderGit2, SquarePen } from 'lucide-react'
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

function GroupChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={11}
      className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    />
  )
}

function SessionRow({
  session,
  activeSessionId,
  onSelect,
}: {
  session: SessionSummary
  activeSessionId: string | null
  onSelect: (id: string) => void
}) {
  const isActive = session.id === activeSessionId
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={`w-full rounded-md px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-1 hover:text-fg'
      }`}
    >
      <span className="block truncate text-sm">{session.title}</span>
      <span className="block truncate text-2xs text-fg-subtle">
        {new Date(session.updatedAt).toLocaleDateString()}
      </span>
    </button>
  )
}

export interface ProjectGroup {
  id: string
  name: string
  sessions: SessionSummary[]
}

/** One collapsible project group with its sessions nested underneath. */
export function ProjectGroupSection({
  group,
  activeSessionId,
  onSelect,
  defaultOpen = true,
}: {
  group: ProjectGroup
  activeSessionId: string | null
  onSelect: (id: string) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <GroupChevron open={open} />
        <FolderGit2 size={11} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-widest text-fg-muted">
          {group.name}
        </span>
        <span className="shrink-0 text-2xs text-fg-subtle">{group.sessions.length}</span>
      </button>
      {open ? (
        <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1.5">
          {group.sessions.map((s) => (
            <li key={s.id}>
              <SessionRow session={s} activeSessionId={activeSessionId} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Sessions grouped under collapsible project sections (T3-style). Named
 * projects first, then the default ad-hoc bucket.
 */
export function SessionsUnderProjects({
  sessions,
  projects,
  activeSessionId,
  onSelect,
}: {
  sessions: SessionSummary[]
  projects: { id: string; name: string }[]
  activeSessionId: string | null
  onSelect: (id: string) => void
}) {
  const groups: ProjectGroup[] = []
  for (const project of projects) {
    const groupSessions = sessions.filter((s) => s.projectId === project.id)
    if (groupSessions.length > 0) {
      groups.push({ id: project.id, name: project.name, sessions: groupSessions })
    }
  }
  const adhoc = sessions.filter((s) => s.projectId === 'adhoc' || !projects.some((p) => p.id === s.projectId))
  if (adhoc.length > 0) groups.push({ id: 'adhoc', name: 'Sessions', sessions: adhoc })

  if (sessions.length === 0) {
    return (
      <div className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2">
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">
          No sessions yet.
          <br />
          Start one with the ✎ button.
        </p>
      </div>
    )
  }

  return (
    <div className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2">
      {groups.map((group) => (
        <ProjectGroupSection
          key={group.id}
          group={group}
          activeSessionId={activeSessionId}
          onSelect={onSelect}
          defaultOpen={group.id === 'adhoc' || group.sessions.some((s) => s.id === activeSessionId)}
        />
      ))}
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
              isActive
                ? 'bg-accent-subtle text-accent'
                : 'text-fg-subtle hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Icon size={14} strokeWidth={isActive ? 2.2 : 1.8} />
          </button>
        )
      })}
    </div>
  )
}

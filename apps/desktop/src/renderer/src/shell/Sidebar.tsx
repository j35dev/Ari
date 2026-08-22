import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronRight, FolderGit2, Pencil, SquarePen, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'

/** M13.1 session-resort spring: FLIP slides when sessions reorder or regroup. */
const RESORT_TRANSITION = { type: 'spring', stiffness: 500, damping: 40 } as const

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
  onRename,
  onDelete,
}: {
  session: SessionSummary
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const isActive = session.id === activeSessionId
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-md px-2 py-1.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              onRename(session.id, draft.trim())
              setEditing(false)
            }
            if (e.key === 'Escape') {
              setDraft(session.title)
              setEditing(false)
            }
          }}
          className="min-w-0 flex-1 rounded-sm border border-border bg-surface-1 px-1.5 py-0.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        />
        <button
          type="button"
          aria-label="Confirm rename"
          onClick={() => {
            if (draft.trim()) onRename(session.id, draft.trim())
            setEditing(false)
          }}
          className="shrink-0 text-success"
        >
          <Check size={13} />
        </button>
        <button
          type="button"
          aria-label="Cancel rename"
          onClick={() => {
            setDraft(session.title)
            setEditing(false)
          }}
          className="shrink-0 text-fg-subtle hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
    )
  }

  if (confirmDelete) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-danger-subtle px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-2xs text-danger">Delete session?</span>
        <button
          type="button"
          aria-label="Confirm delete"
          onClick={() => onDelete(session.id)}
          className="shrink-0 rounded-sm bg-danger px-1.5 py-0.5 text-2xs font-medium text-fg-on-accent"
        >
          Delete
        </button>
        <button
          type="button"
          aria-label="Cancel delete"
          onClick={() => setConfirmDelete(false)}
          className="shrink-0 text-fg-subtle hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="group relative">
      <SessionRowButton
        session={session}
        isActive={isActive}
        onSelect={onSelect}
      />
      <div className="absolute right-1 top-1.5 hidden items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          aria-label="Rename session"
          onClick={() => {
            setDraft(session.title)
            setEditing(true)
          }}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
        >
          <Pencil size={11} />
        </button>
        <button
          type="button"
          aria-label="Delete session"
          onClick={() => setConfirmDelete(true)}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-danger-subtle hover:text-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

/** Compact relative time for session rows: now · 5m · 3h · 2d · date. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const deltaMs = Math.max(0, now - timestamp)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString()
}

function SessionRowButton({
  session,
  isActive,
  onSelect,
}: {
  session: SessionSummary
  isActive: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-12 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-1 hover:text-fg'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{session.title}</span>
      </span>
      <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
        {formatRelativeTime(session.updatedAt)}
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
  onRename,
  onDelete,
  defaultOpen = true,
}: {
  group: ProjectGroup
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
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
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="sessions"
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={RESORT_TRANSITION}
            className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1.5"
          >
            {group.sessions.map((s) => (
              <motion.li key={s.id} layoutId={s.id} transition={RESORT_TRANSITION}>
                <SessionRow
                  session={s}
                  activeSessionId={activeSessionId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              </motion.li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
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
  onRename,
  onDelete,
}: {
  sessions: SessionSummary[]
  projects: { id: string; name: string }[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
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
          onRename={onRename}
          onDelete={onDelete}
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

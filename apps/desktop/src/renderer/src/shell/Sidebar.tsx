import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ChevronRight,
  FolderGit2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'

/** M13.1 session-resort spring: FLIP slides when sessions reorder or regroup. */
const RESORT_TRANSITION = { type: 'spring', stiffness: 500, damping: 40 } as const

/** Recency split between the Active and Earlier sections (T3-style). */
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Sidebar top: wordmark + one-click new session (T3 brand row). */
export function SidebarHeader({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold tracking-tight text-fg">Ari</span>
        <span className="text-2xs text-fg-subtle">beta</span>
      </div>
      <button
        type="button"
        aria-label="New session"
        onClick={onNewSession}
        className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <Plus size={14} />
      </button>
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

function SessionRow({
  session,
  projectName,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary
  projectName: string | null
  isActive: boolean
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
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
          className="min-w-0 flex-1 rounded-sm border border-border bg-glass-input px-1.5 py-0.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
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
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-12 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          isActive ? 'bg-glass-active text-fg' : 'text-fg-muted hover:bg-glass-hover hover:text-fg'
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? 'bg-accent' : 'bg-transparent group-hover:bg-surface-3'}`} />
        <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
        {projectName ? (
          <span className="hidden shrink-0 items-center gap-0.5 text-2xs text-fg-subtle group-hover:hidden lg:flex">
            <FolderGit2 size={10} aria-hidden />
            {projectName}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
          {formatRelativeTime(session.updatedAt)}
        </span>
      </button>
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

function SectionLabel({
  children,
  count,
}: {
  children: React.ReactNode
  count?: number
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-3">
      <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        {children}
      </span>
      {count !== undefined ? (
        <span className="rounded-full bg-surface-2 px-1.5 text-2xs leading-4 text-fg-subtle">
          {count}
        </span>
      ) : null}
    </div>
  )
}

/** Collapsible "Earlier" bucket — collapsed until summoned (T3 Settled pattern). */
function EarlierSection({
  sessions,
  projectNameOf,
  activeSessionId,
  onSelect,
  onRename,
  onDelete,
}: {
  sessions: SessionSummary[]
  projectNameOf: (projectId: string) => string | null
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(
    sessions.some((s) => s.id === activeSessionId),
  )

  // Auto-open when the active session moves into this bucket.
  useEffect(() => {
    if (sessions.some((s) => s.id === activeSessionId)) setOpen(true)
  }, [activeSessionId, sessions])

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
          Earlier
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="earlier"
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={RESORT_TRANSITION}
            className="flex flex-col gap-0.5"
          >
            {sessions.map((s) => (
              <motion.li key={s.id} layoutId={s.id} transition={RESORT_TRANSITION}>
                <SessionRow
                  session={s}
                  projectName={projectNameOf(s.projectId)}
                  isActive={s.id === activeSessionId}
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

export interface ProjectGroup {
  id: string
  name: string
  sessions: SessionSummary[]
}

/**
 * T3-style sidebar body: search box, flat Active section (last 24h), then a
 * collapsible Earlier section. Rows stay flat — no nested project trees —
 * with the owning project shown as a small tag on named-project sessions.
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
  const [query, setQuery] = useState('')
  const trimmed = query.trim().toLowerCase()

  const projectNameOf = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]))
    return (projectId: string): string | null =>
      projectId === 'adhoc' ? null : (byId.get(projectId) ?? null)
  }, [projects])

  // Newest first — the sidebar reads top-down like T3's thread list.
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  )
  const visible = trimmed
    ? sorted.filter((s) => s.title.toLowerCase().includes(trimmed))
    : sorted

  const cutoff = Date.now() - ACTIVE_WINDOW_MS
  const active = visible.filter((s) => s.updatedAt >= cutoff)
  const earlier = visible.filter((s) => s.updatedAt < cutoff)

  if (sessions.length === 0) {
    return (
      <>
        <SidebarSearch query={query} onQueryChange={setQuery} />
        <div className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2">
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-fg-subtle">
            No sessions yet.
            <br />
            Start one with the + button.
          </p>
        </div>
      </>
    )
  }

  return (
    <>
      <SidebarSearch query={query} onQueryChange={setQuery} />
      <nav className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Sessions">
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-fg-subtle">
            No sessions match “{query.trim()}”.
          </p>
        ) : trimmed ? (
          // Searching flattens matches into one list regardless of recency.
          <ul className="flex flex-col gap-0.5">
            {visible.map((s) => (
              <li key={s.id}>
                <SessionRow
                  session={s}
                  projectName={projectNameOf(s.projectId)}
                  isActive={s.id === activeSessionId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        ) : (
          <>
            {active.length > 0 || earlier.length === 0 ? (
              <>
                <SectionLabel count={active.length}>Active</SectionLabel>
                <ul className="flex flex-col gap-0.5">
                  {(active.length > 0 ? active : visible.slice(0, 8)).map((s) => (
                    <li key={s.id}>
                      <SessionRow
                        session={s}
                        projectName={projectNameOf(s.projectId)}
                        isActive={s.id === activeSessionId}
                        onSelect={onSelect}
                        onRename={onRename}
                        onDelete={onDelete}
                      />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {earlier.length > 0 ? (
              <EarlierSection
                sessions={earlier}
                projectNameOf={projectNameOf}
                activeSessionId={activeSessionId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
              />
            ) : null}
          </>
        )}
      </nav>
    </>
  )
}

/** T3-style sidebar search — icon inset, quiet border, glass plate. */
export function SidebarSearch({
  query,
  onQueryChange,
}: {
  query: string
  onQueryChange: (q: string) => void
}) {
  return (
    <div className="px-3 pb-1 pt-2">
      <div className="relative">
        <Search
          size={12}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search…"
          aria-label="Search sessions"
          className="h-7 w-full rounded-lg border border-border bg-glass-input pl-7 pr-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
        />
      </div>
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
    <div className="flex items-center gap-0.5 border-t border-border px-2 py-2">
      {items.map(({ id, label, icon: Icon }) => {
        const isActive = active === id
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => onSelect(id)}
            className={`flex h-8 w-9 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
              isActive
                ? 'bg-accent-subtle text-accent'
                : 'text-fg-subtle hover:bg-glass-hover hover:text-fg'
            }`}
          >
            <Icon size={15} strokeWidth={isActive ? 2.2 : 1.8} />
          </button>
        )
      })}
      <div className="flex-1" />
    </div>
  )
}

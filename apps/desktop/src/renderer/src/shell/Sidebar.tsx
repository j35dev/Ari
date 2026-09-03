import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FolderX,
  Import as ImportIcon,
  Inbox,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectStatus } from '@ari/contracts/project'
import type { SessionSummary } from '@ari/contracts/rpc'
import { SessionActivityMark } from '../features/moment'
import { peakActivity, type SessionActivity } from '../features/session/session-activity'
import {
  sidebarGroups,
  sidebarOrder,
  UNFILED_GROUP_ID,
} from '../features/session/session-nav'
import { useProjectExpand } from './use-project-expand'
import { ContextMenu, useContextMenu } from './ContextMenu'

/** M13.1 session-resort spring: FLIP slides when sessions reorder or regroup. */
const RESORT_TRANSITION = { type: 'spring', stiffness: 500, damping: 40 } as const

/** Sidebar top: wordmark + one-click new session (T3 brand row). */
export function SidebarHeader({
  onNewSession,
  onCollapse,
}: {
  onNewSession: () => void
  onCollapse?: () => void
}) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold tracking-tight text-fg">Ari</span>
        <span className="text-2xs text-fg-subtle">beta</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="New session"
          onClick={onNewSession}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <Plus size={14} />
        </button>
        {onCollapse !== undefined && (
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (Ctrl+B)"
            onClick={onCollapse}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <PanelLeftClose size={14} />
          </button>
        )}
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

function SessionRow({
  session,
  projectName,
  isActive,
  activity,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onToggleArchive,
}: {
  session: SessionSummary
  projectName: string | null
  isActive: boolean
  activity?: SessionActivity
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleArchive: (id: string, archived: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menu = useContextMenu()

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
    <div className="group relative flex items-center">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        onContextMenu={(e) => menu.open(session.id, e)}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 pr-7 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          isActive
            ? 'bg-glass-active text-fg'
            : activity !== undefined
              ? 'text-fg hover:bg-glass-hover'
              : 'text-fg-muted hover:bg-glass-hover hover:text-fg'
        }`}
      >
        <span className="flex size-2.5 shrink-0 items-center justify-center">
          {activity !== undefined ? (
            <SessionActivityMark activity={activity} />
          ) : session.pinned ? (
            <Pin size={10} aria-hidden className="text-accent" />
          ) : (
            <MessageSquareText
              size={11}
              aria-hidden
              className={isActive ? 'text-accent' : 'text-fg-subtle'}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
        {projectName ? (
          <span className="hidden shrink-0 items-center gap-0.5 text-2xs text-fg-subtle lg:flex">
            <FolderGit2 size={10} aria-hidden />
            {projectName}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
          {formatRelativeTime(session.updatedAt)}
        </span>
      </button>
      {/* Sibling, not nested: a control inside a <button> is invalid HTML and
          breaks keyboard semantics. Right-click anywhere on the row opens the
          same menu; this is just the discoverable affordance. */}
      <button
        type="button"
        aria-label={`Session actions for ${session.title}`}
        onClick={(e) => menu.open(session.id, e)}
        className="absolute right-1 flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring group-hover:opacity-100"
      >
        <MoreHorizontal size={13} aria-hidden />
      </button>
      {menu.openFor === session.id ? (
        <ContextMenu
          anchor={menu.anchor}
          label={`Session actions for ${session.title}`}
          onClose={menu.close}
          items={[
            {
              id: 'pin',
              label: session.pinned ? 'Unpin' : 'Pin to top',
              icon: session.pinned ? PinOff : Pin,
              onSelect: () => onTogglePin(session.id, !session.pinned),
            },
            {
              id: 'rename',
              label: 'Rename',
              icon: Pencil,
              onSelect: () => {
                setDraft(session.title)
                setEditing(true)
              },
            },
            {
              id: 'archive',
              label: session.archived ? 'Unarchive' : 'Archive',
              icon: session.archived ? ArchiveRestore : Archive,
              onSelect: () => onToggleArchive(session.id, !session.archived),
            },
            {
              id: 'delete',
              label: 'Delete session',
              icon: Trash2,
              danger: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
      ) : null}
    </div>
  )
}

/** Handlers every session row needs; passed down unchanged through groups. */
interface SessionRowHandlers {
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleArchive: (id: string, archived: boolean) => void
  /** Live working/paused/done overlay; omit in tests that only cover listing. */
  activityOf?: (sessionId: string) => SessionActivity | undefined
}

/** FLIP-animated session list; shared by groups, the archived shelf and search. */
function SessionList({
  sessions,
  projectNameOf,
  handlers,
}: {
  sessions: SessionSummary[]
  projectNameOf?: (projectId: string) => string | null
  handlers: SessionRowHandlers
}) {
  return (
    <motion.ul layout className="flex flex-col gap-0.5" transition={RESORT_TRANSITION}>
      {sessions.map((s) => (
        <motion.li key={s.id} layoutId={s.id} transition={RESORT_TRANSITION}>
          <SessionRow
            session={s}
            projectName={projectNameOf?.(s.projectId) ?? null}
            isActive={s.id === handlers.activeSessionId}
            activity={handlers.activityOf?.(s.id)}
            onSelect={handlers.onSelect}
            onRename={handlers.onRename}
            onDelete={handlers.onDelete}
            onTogglePin={handlers.onTogglePin}
            onToggleArchive={handlers.onToggleArchive}
          />
        </motion.li>
      ))}
    </motion.ul>
  )
}

/** Collapsible global shelf (Archived) — collapsed until summoned. */
function CollapsibleSessions({
  label,
  sessions,
  projectNameOf,
  handlers,
  icon,
}: {
  label: string
  sessions: SessionSummary[]
  projectNameOf: (projectId: string) => string | null
  handlers: SessionRowHandlers
  icon?: LucideIcon
}) {
  const Icon = icon
  const [open, setOpen] = useState(sessions.some((s) => s.id === handlers.activeSessionId))

  // Auto-open when the active session moves into this bucket.
  useEffect(() => {
    if (sessions.some((s) => s.id === handlers.activeSessionId)) setOpen(true)
  }, [handlers.activeSessionId, sessions])

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
        {Icon ? <Icon size={12} aria-hidden className="shrink-0 text-fg-subtle" /> : null}
        <span className="text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
          {label}
        </span>
        <span className="rounded-full bg-surface-2 px-1.5 text-2xs leading-4 text-fg-subtle">
          {sessions.length}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key={label}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={RESORT_TRANSITION}
          >
            <SessionList sessions={sessions} projectNameOf={projectNameOf} handlers={handlers} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/** A project as the sidebar needs it: identity plus live folder status. */
export interface SidebarProject {
  id: string
  name: string
  path?: string
  status?: ProjectStatus
}

/** Per-project commands surfaced on group hover / in the degraded state. */
export interface ProjectActions {
  onNewSessionInProject?: (projectId: string) => void
  onImportSessions?: (projectId: string) => void
  onRevealProject?: (projectId: string) => void
  onCloseProject?: (projectId: string) => void
  onRemoveProject?: (projectId: string) => void
  /** Re-pick the folder of a project whose path went missing. */
  onLocateProject?: (projectId: string) => void
}

/**
 * One collapsible sidebar group: an open project (or the trailing Unfiled
 * bucket) with its sessions nested inside, pinned first. A project whose
 * folder vanished renders muted with Locate / Close affordances; its sessions
 * still load and stay selectable.
 */
function ProjectGroupSection({
  name,
  project,
  sessions,
  expanded,
  onToggle,
  handlers,
  actions,
}: {
  name: string
  project: SidebarProject | null
  sessions: SessionSummary[]
  expanded: boolean
  onToggle: () => void
  handlers: SessionRowHandlers
  actions: ProjectActions
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const menu = useContextMenu()
  const missing = project?.status === 'missing'
  const groupActivity = peakActivity(sessions.map((s) => handlers.activityOf?.(s.id)))
  const GroupIcon: LucideIcon = project === null ? Inbox : missing ? FolderX : expanded ? FolderOpen : Folder

  return (
    <section className="group/project" aria-label={name}>
      <div className="relative flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          onContextMenu={project ? (e) => menu.open(project.id, e) : undefined}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
            project ? 'pr-7' : ''
          } ${missing ? 'opacity-60' : ''}`}
        >
          <ChevronRight
            size={11}
            aria-hidden
            className={`shrink-0 text-fg-subtle transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          />
          <GroupIcon
            size={12}
            aria-hidden
            className={`shrink-0 ${missing ? 'text-warning' : 'text-fg-subtle'}`}
          />
          <span
            className={`min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-[0.14em] ${
              missing ? 'text-fg-subtle line-through' : 'text-fg-subtle'
            }`}
          >
            {name}
          </span>
          {groupActivity !== undefined ? <SessionActivityMark activity={groupActivity} /> : null}
          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-2xs leading-4 text-fg-subtle">
            {sessions.length}
          </span>
        </button>
        {project ? (
          <button
            type="button"
            aria-label={`Project actions for ${name}`}
            onClick={(e) => menu.open(project.id, e)}
            className="absolute right-1 flex h-5 w-5 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring group-hover/project:opacity-100"
          >
            <MoreHorizontal size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      {project && menu.openFor === project.id ? (
        <ContextMenu
          anchor={menu.anchor}
          label={`Project actions for ${name}`}
          onClose={menu.close}
          items={[
            {
              id: 'new',
              label: 'New session here',
              icon: Plus,
              onSelect: () => actions.onNewSessionInProject?.(project.id),
            },
            {
              id: 'import',
              label: 'Import',
              icon: ImportIcon,
              disabled: missing,
              disabledReason: missing ? 'Locate this project before importing sessions' : undefined,
              onSelect: () => actions.onImportSessions?.(project.id),
            },
            {
              id: 'reveal',
              label: 'Reveal in file manager',
              icon: FolderOpen,
              onSelect: () => actions.onRevealProject?.(project.id),
            },
            {
              id: 'close',
              label: 'Close project',
              icon: X,
              onSelect: () => actions.onCloseProject?.(project.id),
            },
            {
              id: 'remove',
              label: 'Remove project',
              icon: Trash2,
              danger: true,
              onSelect: () => setConfirmRemove(true),
            },
          ]}
        />
      ) : null}
      {project && confirmRemove ? (
        <div className="flex items-center gap-2 rounded-md bg-danger-subtle px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-2xs text-danger">Remove project?</span>
          <button
            type="button"
            aria-label={`Confirm remove ${name}`}
            onClick={() => {
              setConfirmRemove(false)
              actions.onRemoveProject?.(project.id)
            }}
            className="shrink-0 rounded-sm bg-danger px-1.5 py-0.5 text-2xs font-medium text-fg-on-accent"
          >
            Remove
          </button>
          <button
            type="button"
            aria-label={`Keep ${name}`}
            onClick={() => setConfirmRemove(false)}
            className="shrink-0 text-fg-subtle hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      {project && missing ? (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-2xs text-fg-muted">folder missing</span>
          <button
            type="button"
            onClick={() => actions.onLocateProject?.(project.id)}
            className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:text-fg"
          >
            Locate
          </button>
          <button
            type="button"
            onClick={() => actions.onCloseProject?.(project.id)}
            className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:text-fg"
          >
            Close
          </button>
        </div>
      ) : null}
      {expanded ? (
        sessions.length > 0 ? (
          <SessionList sessions={sessions} handlers={handlers} />
        ) : (
          <p className="px-4 py-1.5 text-2xs text-fg-subtle">No sessions yet.</p>
        )
      ) : null}
    </section>
  )
}

/**
 * Sidebar body: search, an Open-project action, then one collapsible group per
 * open project with its sessions nested inside (pinned first within the
 * group), a trailing Unfiled group for ad-hoc sessions, and the global
 * Archived shelf at the bottom. Searching flattens matches across every
 * project into one list.
 */
export function SessionsUnderProjects({
  sessions,
  projects,
  activeSessionId,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onToggleArchive,
  activityOf,
  onOpenProject,
  knownProjectNames,
  ...actions
}: SessionRowHandlers &
  ProjectActions & {
    sessions: SessionSummary[]
    projects: SidebarProject[]
    /** Every known project (open or not), so archived/search rows keep their origin chip. */
    knownProjectNames?: { id: string; name: string }[]
    /** Opens the native folder picker; a cancel is a silent no-op. */
    onOpenProject?: () => void
  }) {
  const [query, setQuery] = useState('')
  const trimmed = query.trim().toLowerCase()
  const { isExpanded, toggle } = useProjectExpand()
  const handlers: SessionRowHandlers = {
    activeSessionId,
    onSelect,
    onRename,
    onDelete,
    onTogglePin,
    onToggleArchive,
    activityOf,
  }

  const projectNameOf = useMemo(() => {
    const byId = new Map((knownProjectNames ?? projects).map((p) => [p.id, p.name]))
    return (projectId: string): string | null =>
      projectId === UNFILED_GROUP_ID ? null : (byId.get(projectId) ?? null)
  }, [projects, knownProjectNames])

  // Same grouping the keyboard traversal walks (sidebarOrder flattens it).
  const groups = useMemo(() => sidebarGroups(sessions, projects), [sessions, projects])
  const matches = useMemo(
    () =>
      trimmed
        ? sidebarOrder(sessions, projects).filter((s) => s.title.toLowerCase().includes(trimmed))
        : [],
    [sessions, projects, trimmed],
  )
  // Newest-first shelf of everything archived (the groups exclude them).
  const archived = useMemo(
    () => [...sessions].filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  )

  const body =
    trimmed !== '' ? (
      matches.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">
          No sessions match “{query.trim()}”.
        </p>
      ) : (
        <SessionList sessions={matches} projectNameOf={projectNameOf} handlers={handlers} />
      )
    ) : groups.length === 0 && archived.length === 0 ? (
      <p className="px-2 py-8 text-center text-xs leading-relaxed text-fg-subtle">
        No sessions yet.
        <br />
        Open a project or start one with the + button.
      </p>
    ) : (
      <>
        {groups.map((group) => {
          const project = projects.find((p) => p.id === group.id) ?? null
          return (
            <ProjectGroupSection
              key={group.id}
              name={group.name}
              project={project}
              sessions={group.sessions}
              expanded={isExpanded(group.id)}
              onToggle={() => toggle(group.id)}
              handlers={handlers}
              actions={actions}
            />
          )
        })}
        {archived.length > 0 ? (
          <CollapsibleSessions
            label="Archived"
            sessions={archived}
            projectNameOf={projectNameOf}
            handlers={handlers}
            icon={Archive}
          />
        ) : null}
      </>
    )

  return (
    <>
      <SidebarSearch query={query} onQueryChange={setQuery} />
      <div className="px-3 pb-1">
        <button
          type="button"
          onClick={() => onOpenProject?.()}
          className="flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-glass-input text-xs font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <FolderPlus size={12} aria-hidden />
          Open project
        </button>
      </div>
      <nav className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Sessions">
        {body}
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

export type SidebarNavId =
  | 'session'
  | 'terminal'
  | 'changes'
  | 'settings'
  | 'files'
  | 'usage'



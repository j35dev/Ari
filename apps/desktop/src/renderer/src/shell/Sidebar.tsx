import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { AnimatePresence, motion, Reorder, useDragControls } from 'motion/react'
import type { DragControls } from 'motion/react'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Import as ImportIcon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import { Kbd } from '@ari/ui/kbd'
import { transitions } from '@ari/ui/motion'
import type { ProjectStatus } from '@ari/contracts/project'
import type { SessionSummary } from '@ari/contracts/rpc'
import { SessionActivityMark } from '../features/moment'
import { peakActivity, type SessionActivity } from '../features/session/session-activity'
import { ContextMark } from './ContextMark'
import {
  projectMoveFromOrder,
  recencyGroups,
  sidebarGroups,
  UNFILED_GROUP_ID,
  type SidebarGroup,
} from '../features/session/session-nav'
import { useProjectExpand } from './use-project-expand'
import { useSessionCollapse } from './use-session-collapse'
import { useSidebarView, type SidebarView } from './use-sidebar-view'
import { sessionTree, searchSessionTree } from '../features/session/session-tree'
import { ContextMenu, useContextMenu } from './ContextMenu'

/**
 * Position-only FLIP for session reorder and project expand. Ease-slide keeps
 * sibling rows translating while a group grows or collapses.
 */
const LIST_LAYOUT = { layout: 'position' as const, transition: transitions.resort }

/** Pointer travel (px) beyond which a header press is a drag, not a click. */
const DRAG_CLICK_SLOP_PX = 4

/** One indent column; children sit clearly under the parent orchestrator. */
const TREE_COL_PX = 16

/** Vertical rail + elbow for nested child sessions, in the border tone. */
function SessionTreeGuides({ lastAtDepth }: { lastAtDepth: readonly boolean[] }) {
  if (lastAtDepth.length === 0) return null
  const stroke = 'var(--ari-border-strong)'
  return (
    <span
      aria-hidden
      data-tree-guides=""
      className="pointer-events-none relative shrink-0 self-stretch"
      style={{ width: lastAtDepth.length * TREE_COL_PX }}
    >
      {lastAtDepth.map((isLast, i) => {
        const current = i === lastAtDepth.length - 1
        return (
          <span key={i} className="absolute inset-y-0" style={{ left: i * TREE_COL_PX + 7 }}>
            {current || !isLast ? (
              <span
                className="absolute left-0 w-px"
                style={{
                  background: stroke,
                  top: -2,
                  height: current && isLast ? 'calc(50% + 2px)' : 'calc(100% + 4px)',
                }}
              />
            ) : null}
            {current ? (
              <span className="absolute left-0 top-1/2 h-px w-2.5" style={{ background: stroke }} />
            ) : null}
          </span>
        )
      })}
    </span>
  )
}

const ICON_BTN =
  'flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg active:bg-glass-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** Small trailing affordance (session / project menu) revealed on row hover. */
const ROW_ACTION_BTN =
  'absolute right-1.5 flex size-5 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-opacity hover:bg-glass-active hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** Quiet section caption shared by the view switch, recency buckets and shelves. */
const SECTION_LABEL = 'text-[11px] font-medium tracking-[0.01em] text-fg-subtle'

/** Compact product wordmark; search and collapse sit as icon actions. */
export function SidebarHeader({
  onSearch,
  onCollapse,
}: {
  onSearch?: () => void
  onCollapse?: () => void
}) {
  return (
    <header className="flex h-12 shrink-0 items-center px-3">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span aria-label="Ari" className="text-[15px] font-semibold tracking-[-0.03em] text-fg">
          Ari
          <span aria-hidden="true" className="text-accent">
            .
          </span>
        </span>
      </div>

      <div className="flex items-center gap-0.5">
        {onSearch !== undefined ? (
          <button
            type="button"
            aria-label="Search sessions"
            title="Search sessions"
            onClick={onSearch}
            className={ICON_BTN}
          >
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
        {onCollapse !== undefined ? (
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (Ctrl+B)"
            onClick={onCollapse}
            className={ICON_BTN}
          >
            <PanelLeftClose size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
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
  hasChildren = false,
  childCount = 0,
  nested = false,
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
  hasChildren?: boolean
  childCount?: number
  nested?: boolean
  /** Origin project, surfaced as a tooltip in flat lists (search, archived, sessions view). */
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
        <span className="min-w-0 flex-1 truncate text-2xs text-danger">
          {hasChildren ? 'Delete this session and its children?' : 'Delete session?'}
        </span>
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
    <div
      className="group relative flex items-center"
      data-session-role={hasChildren ? 'parent' : nested ? 'child' : undefined}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        onContextMenu={(e) => menu.open(session.id, e)}
        title={projectName ?? undefined}
        className={`flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          isActive ? 'bg-accent/15 text-fg font-medium'
            : activity !== undefined
              ? 'text-fg hover:bg-glass-hover'
              : 'text-fg-muted hover:bg-glass-hover hover:text-fg'
        }`}
      >
        <span className="flex size-3 shrink-0 items-center justify-center">
          {activity !== undefined ? (
            <SessionActivityMark activity={activity} />
          ) : hasChildren ? (
            <GitBranch
              size={11}
              aria-hidden
              className={isActive ? 'text-accent' : 'text-fg-muted'}
            />
          ) : session.pinned ? (
            <Pin size={10} aria-hidden className="text-accent" />
          ) : (
            <span
              data-session-mark="idle"
              className={`rounded-full ${nested ? 'size-1' : 'size-1.5'}`}
              style={{
                background: 'var(--ari-fg-subtle)',
                opacity: isActive ? 0.9 : nested ? 0.4 : 0.55,
              }}
            />
          )}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            hasChildren ? 'font-medium text-fg' : nested && !isActive ? 'text-fg-muted' : ''
          }`}
        >
          {session.title}
        </span>
        {hasChildren && childCount > 0 ? (
          <span className="shrink-0 text-2xs tabular-nums text-fg-subtle">{childCount}</span>
        ) : null}
        <span className="shrink-0 text-2xs tabular-nums text-fg-subtle transition-opacity group-hover:opacity-0">
          {formatRelativeTime(session.updatedAt)}
        </span>
      </button>
      {/* Sibling, not nested: a control inside a <button> is invalid HTML and
          breaks keyboard semantics. Right-click anywhere on the row opens the
          same menu; this is just the discoverable affordance. It takes over the
          timestamp slot while the row is hovered. */}
      <button
        type="button"
        aria-label={`Session actions for ${session.title}`}
        onClick={(e) => menu.open(session.id, e)}
        className={`${ROW_ACTION_BTN} group-hover:opacity-100`}
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
              label: hasChildren
                ? session.archived
                  ? 'Unarchive subtree'
                  : 'Archive subtree'
                : session.archived
                  ? 'Unarchive'
                  : 'Archive',
              icon: session.archived ? ArchiveRestore : Archive,
              onSelect: () => onToggleArchive(session.id, !session.archived),
            },
            {
              id: 'delete',
              label: hasChildren ? 'Delete session and children' : 'Delete session',
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
  searching = false,
  projectNameOf,
  handlers,
}: {
  sessions: SessionSummary[]
  searching?: boolean
  projectNameOf?: (projectId: string) => string | null
  handlers: SessionRowHandlers
}) {
  const { collapsed, toggle } = useSessionCollapse()
  return (
    <ul className="flex flex-col gap-0.5">
      {sessionTree(sessions, searching ? new Set() : collapsed).map(
        ({ session: s, childCount, lastAtDepth }) => {
          const expanded = !collapsed.has(s.id)
          return (
            <motion.li key={s.id} {...LIST_LAYOUT}>
              <div className="flex items-center">
                <SessionTreeGuides lastAtDepth={lastAtDepth} />
                {childCount > 0 && !searching ? (
                  <button
                    type="button"
                    aria-label={
                      expanded ? `Collapse children of ${s.title}` : `Expand children of ${s.title}`
                    }
                    aria-expanded={expanded}
                    className="flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    onClick={() => toggle(s.id)}
                    onKeyDown={(event) => {
                      if (
                        (event.key === 'ArrowLeft' && expanded) ||
                        (event.key === 'ArrowRight' && !expanded)
                      ) {
                        event.preventDefault()
                        toggle(s.id)
                      }
                    }}
                  >
                    <ChevronRight
                      size={10}
                      aria-hidden
                      className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                    />
                  </button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <SessionRow
                    session={s}
                    hasChildren={childCount > 0}
                    childCount={childCount}
                    nested={lastAtDepth.length > 0}
                    projectName={projectNameOf?.(s.projectId) ?? null}
                    isActive={s.id === handlers.activeSessionId}
                    activity={handlers.activityOf?.(s.id)}
                    onSelect={handlers.onSelect}
                    onRename={handlers.onRename}
                    onDelete={handlers.onDelete}
                    onTogglePin={handlers.onTogglePin}
                    onToggleArchive={handlers.onToggleArchive}
                  />
                </div>
              </div>
            </motion.li>
          )
        },
      )}
    </ul>
  )
}

/** Collapsible global shelf (Archived) — collapsed until summoned. */
function CollapsibleSessions({
  label,
  sessions,
  projectNameOf,
  handlers,
}: {
  label: string
  sessions: SessionSummary[]
  projectNameOf: (projectId: string) => string | null
  handlers: SessionRowHandlers
}) {
  const [open, setOpen] = useState(sessions.some((s) => s.id === handlers.activeSessionId))

  // Auto-open when the active session moves into this bucket.
  useEffect(() => {
    if (sessions.some((s) => s.id === handlers.activeSessionId)) setOpen(true)
  }, [handlers.activeSessionId, sessions])

  // The shelf keeps the active-location signal: its caret fills while the
  // active session sits inside, even though the shelf opens on its own.
  const shelfActive =
    handlers.activeSessionId != null &&
    sessions.some((s) => s.id === handlers.activeSessionId)

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-fg-muted transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ContextMark variant="archived" active={shelfActive} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-2xs leading-4 text-fg-subtle">
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
            transition={transitions.morph}
          >
            <div className="pt-0.5">
              <SessionList
                sessions={sessions}
                projectNameOf={projectNameOf}
                handlers={handlers}
              />
            </div>
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
  /** Persist a drag: slot `projectId` immediately before `beforeId` (null = last). */
  onReorderProject?: (projectId: string, beforeId: string | null) => void
  /** Keyboard path (project menu): nudge a project one slot up (-1) or down (+1). */
  onMoveProject?: (projectId: string, delta: -1 | 1) => void
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
  drag,
  canMoveUp,
  canMoveDown,
}: {
  name: string
  project: SidebarProject | null
  sessions: SessionSummary[]
  expanded: boolean
  onToggle: () => void
  handlers: SessionRowHandlers
  actions: ProjectActions
  /** Present on reorderable project groups; Unfiled is a derived trailing group. */
  drag?: { controls: DragControls; onPressStart: () => void }
  canMoveUp?: boolean
  canMoveDown?: boolean
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const menu = useContextMenu()
  // Distinguishes the click that follows a header release from the drag that
  // started on it: only a press that did not travel toggles the group.
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const missing = project?.status === 'missing'
  const groupActivity = peakActivity(sessions.map((s) => handlers.activityOf?.(s.id)))
  const isActiveGroup = sessions.some((s) => s.id === handlers.activeSessionId)

  return (
    <section className="group/project" aria-label={name}>
      <div data-active-group={isActiveGroup ? '' : undefined}>
        <div className="relative flex items-center">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(e) => {
              const origin = pressOrigin.current
              pressOrigin.current = null
              if (
                origin &&
                Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > DRAG_CLICK_SLOP_PX
              ) {
                return
              }
              onToggle()
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !drag) return
              pressOrigin.current = { x: e.clientX, y: e.clientY }
              drag.onPressStart()
              drag.controls.start(e)
            }}
            onContextMenu={project ? (e) => menu.open(project.id, e) : undefined}
            className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
              missing ? 'opacity-60' : ''
            } ${isActiveGroup ? 'text-fg' : 'text-fg-muted hover:text-fg'}`}
          >
            <ContextMark variant={project ? 'project' : 'unfiled'} active={isActiveGroup} />
            <span
              className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
                missing ? 'text-fg-subtle line-through' : ''
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
              className={`${ROW_ACTION_BTN} group-hover/project:opacity-100`}
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
                disabledReason: missing
                  ? 'Locate this project before importing sessions'
                  : undefined,
                onSelect: () => actions.onImportSessions?.(project.id),
              },
              {
                id: 'reveal',
                label: 'Reveal in file manager',
                icon: FolderOpen,
                onSelect: () => actions.onRevealProject?.(project.id),
              },
              {
                id: 'move-up',
                label: 'Move up',
                icon: ArrowUp,
                disabled: !canMoveUp,
                disabledReason: canMoveUp ? undefined : 'Already the top project',
                onSelect: () => actions.onMoveProject?.(project.id, -1),
              },
              {
                id: 'move-down',
                label: 'Move down',
                icon: ArrowDown,
                disabled: !canMoveDown,
                disabledReason: canMoveDown ? undefined : 'Already the last project',
                onSelect: () => actions.onMoveProject?.(project.id, 1),
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
            <div className="pb-1 pl-5">
              <SessionList sessions={sessions} handlers={handlers} />
            </div>
          ) : (
            <p className="py-1 pl-9 text-2xs text-fg-subtle">No sessions yet.</p>
          )
        ) : null}
      </div>
    </section>
  )
}

/**
 * One project group wrapped for drag-reorder. The drag starts on the group
 * header (`dragListener={false}` keeps session rows and nested controls
 * undraggable); `onPressStart` records which group the press began on so the
 * reorder callback can derive the persisted move.
 */
function DraggableProjectGroup({
  group,
  project,
  sessions,
  expanded,
  onToggle,
  handlers,
  actions,
  canMoveUp,
  canMoveDown,
  onPressStart,
}: {
  group: SidebarGroup
  project: SidebarProject | null
  sessions: SessionSummary[]
  expanded: boolean
  onToggle: () => void
  handlers: SessionRowHandlers
  actions: ProjectActions
  canMoveUp: boolean
  canMoveDown: boolean
  onPressStart: () => void
}) {
  const controls = useDragControls()
  return (
    <Reorder.Item
      value={group.id}
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={transitions.resort}
    >
      <ProjectGroupSection
        name={group.name}
        project={project}
        sessions={sessions}
        expanded={expanded}
        onToggle={onToggle}
        handlers={handlers}
        actions={actions}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        drag={{ controls, onPressStart }}
      />
    </Reorder.Item>
  )
}

/**
 * Sidebar body: a compose row, then either the Projects view (one collapsible
 * group per open project with its sessions nested inside, pinned first, a
 * trailing Unfiled group, drag-reorderable) or the Sessions view (every live
 * session in one flat list bucketed by recency), plus the global Archived
 * shelf. Searching flattens matches across every project into one list.
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
  onNewSession,
  searchInputRef,
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
    onNewSession?: () => void
    searchInputRef?: Ref<HTMLInputElement>
  }) {
  const [query, setQuery] = useState('')
  const trimmed = query.trim().toLowerCase()
  const { isExpanded, toggle } = useProjectExpand()
  const { view, setView } = useSidebarView()
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
  // Projects reorder among themselves; Unfiled stays a derived, trailing group.
  const projectGroups = useMemo(() => groups.filter((g) => g.id !== UNFILED_GROUP_ID), [groups])
  const unfiled = groups.find((g) => g.id === UNFILED_GROUP_ID)
  // Set on header pointer-down, consumed by the reorder it may trigger.
  const pressedGroupId = useRef<string | null>(null)

  const reorderFromDrag = (nextIds: string[]): void => {
    const draggedId = pressedGroupId.current
    pressedGroupId.current = null
    if (!draggedId) return
    const move = projectMoveFromOrder(
      projectGroups.map((g) => g.id),
      nextIds,
      draggedId,
    )
    if (move) actions.onReorderProject?.(move.id, move.beforeId)
  }
  const matches = useMemo(
    () => (trimmed ? searchSessionTree(sessions, trimmed) : []),
    [sessions, trimmed],
  )
  // Newest-first shelf of everything archived (the groups exclude them).
  const archived = useMemo(
    () => [...sessions].filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  )
  // Recency buckets derive from the calendar day: re-render when it rolls over
  // so an idle window never labels yesterday's sessions as Today past midnight.
  const [dayTick, setDayTick] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setDayTick((prev) => {
        const now = Date.now()
        return new Date(prev).toDateString() === new Date(now).toDateString() ? prev : now
      })
    }, 60_000)
    return () => clearInterval(timer)
  }, [])
  const recent = useMemo(
    () => (view === 'sessions' ? recencyGroups(sessions, dayTick) : []),
    [sessions, view, dayTick],
  )

  const archivedShelf =
    archived.length > 0 ? (
      <div className="mt-2">
        <CollapsibleSessions
          label="Archived"
          sessions={archived}
          projectNameOf={projectNameOf}
          handlers={handlers}
        />
      </div>
    ) : null

  const body =
    trimmed !== '' ? (
      matches.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">
          No sessions match “{query.trim()}”.
        </p>
      ) : (
        <SessionList
          sessions={matches}
          searching
          projectNameOf={projectNameOf}
          handlers={handlers}
        />
      )
    ) : groups.length === 0 && archived.length === 0 ? (
      <p className="px-2 py-8 text-center text-xs leading-relaxed text-fg-subtle">
        No sessions yet.
        <br />
        Open a project or start a session.
      </p>
    ) : view === 'sessions' ? (
      <>
        {recent.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-fg-subtle">No sessions yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((group) => (
              <section key={group.id} aria-label={group.name}>
                <h3 className={`${SECTION_LABEL} h-6 px-2 leading-6`}>{group.name}</h3>
                <SessionList
                  sessions={group.sessions}
                  projectNameOf={projectNameOf}
                  handlers={handlers}
                />
              </section>
            ))}
          </div>
        )}
        {archivedShelf}
      </>
    ) : (
      <>
        <Reorder.Group
          axis="y"
          values={projectGroups.map((g) => g.id)}
          onReorder={reorderFromDrag}
          layout="position"
          className="flex flex-col gap-0.5"
        >
          {projectGroups.map((group, index) => (
            <DraggableProjectGroup
              key={group.id}
              group={group}
              project={projects.find((p) => p.id === group.id) ?? null}
              sessions={group.sessions}
              expanded={isExpanded(group.id)}
              onToggle={() => toggle(group.id)}
              handlers={handlers}
              actions={actions}
              canMoveUp={index > 0}
              canMoveDown={index < projectGroups.length - 1}
              onPressStart={() => (pressedGroupId.current = group.id)}
            />
          ))}
        </Reorder.Group>
        {unfiled ? (
          <div className="mt-0.5">
            <ProjectGroupSection
              name={unfiled.name}
              project={null}
              sessions={unfiled.sessions}
              expanded={isExpanded(UNFILED_GROUP_ID)}
              onToggle={() => toggle(UNFILED_GROUP_ID)}
              handlers={handlers}
              actions={actions}
            />
          </div>
        ) : null}
        {archivedShelf}
      </>
    )

  return (
    <>
      <div className="px-2 pt-1">
        <button
          type="button"
          aria-label="New session"
          title="New session (Mod+N)"
          onClick={() => onNewSession?.()}
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-glass-input px-2.5 text-[13px] font-medium text-fg transition-colors hover:border-border-strong hover:bg-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <SquarePen size={14} strokeWidth={1.8} aria-hidden className="text-fg-muted" />
          New session
          <Kbd className="ml-auto h-4 border-border/60 px-1 text-[10px] text-fg-subtle">Mod+N</Kbd>
        </button>
      </div>
      <SidebarSearch query={query} onQueryChange={setQuery} inputRef={searchInputRef} collapsed />
      {trimmed === '' ? (
        <SidebarViewSwitch view={view} onChange={setView} onOpenProject={onOpenProject} />
      ) : null}
      <nav className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Sessions">
        {body}
      </nav>
    </>
  )
}

/**
 * Section caption doubling as the Projects / Sessions view switch, with the
 * open-project affordance trailing. Sits between the compose row and the list
 * so the list itself carries no chrome.
 */
function SidebarViewSwitch({
  view,
  onChange,
  onOpenProject,
}: {
  view: SidebarView
  onChange: (view: SidebarView) => void
  onOpenProject?: () => void
}) {
  const tab = (id: SidebarView, label: string) => {
    const selected = view === id
    return (
      <button
        key={id}
        type="button"
        aria-pressed={selected}
        onClick={() => onChange(id)}
        className={`rounded-sm px-1 text-[11px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          selected ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
        }`}
      >
        {label}
      </button>
    )
  }
  return (
    <div className="flex h-8 items-center gap-1 px-3">
      <div role="group" aria-label="Sidebar view" className="flex items-center gap-1">
        {tab('projects', 'Projects')}
        <span aria-hidden className="text-[11px] text-fg-subtle/60">
          ·
        </span>
        {tab('sessions', 'Sessions')}
      </div>
      <button
        type="button"
        aria-label="Open project"
        title="Open project"
        onClick={() => onOpenProject?.()}
        className="ml-auto flex size-5 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <FolderPlus size={13} strokeWidth={1.8} aria-hidden />
      </button>
    </div>
  )
}

/** Sidebar session search — icon inset, quiet until focused or filled. */
export function SidebarSearch({
  query,
  onQueryChange,
  inputRef,
  collapsed = false,
}: {
  query: string
  onQueryChange: (q: string) => void
  inputRef?: Ref<HTMLInputElement>
  collapsed?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const visible = !collapsed || focused || query.length > 0

  return (
    <div className={visible ? 'px-3 pb-1 pt-1' : 'sr-only'}>
      <div className="relative">
        <Search
          size={12}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onQueryChange('')
              e.currentTarget.blur()
            }
          }}
          placeholder="Search…"
          aria-label="Search sessions"
          className="h-7 w-full rounded-lg border border-border bg-glass-input pl-7 pr-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
        />
      </div>
    </div>
  )
}

export type SidebarNavId = 'session' | 'terminal' | 'changes' | 'settings' | 'files' | 'usage'

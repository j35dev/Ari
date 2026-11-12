import { memo, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { motion, Reorder, useDragControls } from 'motion/react'
import type { DragControls } from 'motion/react'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Import as ImportIcon,
  Monitor,
  MoreHorizontal,
  PanelBottom,
  PanelLeftClose,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import { AriaMark } from '@ari/ui/aria-mark'
import { visibleProjects, visibleSessions } from '../features/aria/visibility'
import { transitions } from '@ari/ui/motion'
import type { ProjectStatus } from '@ari/contracts/project'
import type { SessionSummary } from '@ari/contracts/rpc'
import { SessionActivityMark, useTickingText } from '../features/moment'
import {
  peakActivity,
  treeActivity,
  type SessionActivity,
} from '../features/session/session-activity'
import { driverLabel } from '../features/composer/agent-mark'
import { ProviderLogo } from '../features/composer/provider-logo'
import { setDragSession } from '../features/split/drag-split'
import type { PaneEdge } from '../features/split/split-layout'
import { cx, iconButton, rowAction, rowSelected, sectionLabel } from '../lib/recipes'
import { ContextMark } from './ContextMark'
import {
  inboxSplit,
  projectMoveFromOrder,
  sidebarGroups,
  UNFILED_GROUP_ID,
  type SidebarGroup,
} from '../features/session/session-nav'
import { useProjectExpand } from './use-project-expand'
import { useStableHandlers } from './use-stable-handlers'
import { useSessionCollapse } from './use-session-collapse'
import { useSidebarView, type SidebarView } from './use-sidebar-view'
import {
  archiveTargetIds,
  descendantIds,
  searchSessionTree,
  selectionRoots,
  sessionTree,
} from '../features/session/session-tree'
import {
  ContextMenu,
  anchorBelow,
  useContextMenu,
  type ContextMenuItem,
  type MenuAnchor,
} from './ContextMenu'

/**
 * Position-only FLIP for session reorder and child-tree expand. Every layout
 * node is measured whenever any motion layout anywhere in the app updates, so
 * rows opt in only when their list actually changed: `layoutDependency` is the
 * list's row order, and a re-render that leaves it alone measures nothing.
 */
const LIST_LAYOUT = { layout: 'position' as const, transition: transitions.resort }

/** Pointer travel (px) beyond which a header press is a drag, not a click. */
const DRAG_CLICK_SLOP_PX = 4

/**
 * Row geometry, in px from a row's left edge. A session title starts where
 * its project's name does (past the letter tile); each level of delegation
 * steps one column further in, on a tree line just inside the parent's title.
 */
const ROW_INSET_PX = 10
const ROW_INDENT_PX = 38
const TREE_COL_PX = 18
const TREE_LINE_PX = 44
/** Width the select-mode checkbox takes ahead of a row. */
const SELECT_COL_PX = 24

const NO_DEPTH: readonly boolean[] = []

/**
 * Tree line for nested child sessions: one hairline per open level, running
 * down the group and stopping at the middle of its last child. It reaches a
 * pixel up to bridge the gap between rows. No elbows, no boxes.
 */
function SessionTreeGuides({
  lastAtDepth,
  offset = 0,
}: {
  lastAtDepth: readonly boolean[]
  offset?: number
}) {
  if (lastAtDepth.length === 0) return null
  return (
    <span aria-hidden data-tree-guides="" className="pointer-events-none absolute inset-y-0 left-0">
      {lastAtDepth.map((isLast, i) => {
        const current = i === lastAtDepth.length - 1
        if (!current && isLast) return null
        return (
          <span
            key={i}
            className="absolute -top-px w-px bg-border-strong"
            style={{
              left: offset + TREE_LINE_PX + i * TREE_COL_PX,
              bottom: current && isLast ? '50%' : 0,
            }}
          />
        )
      })}
    </span>
  )
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** 34px top-level row: New session, and Aria above it. */
const NAV_ROW = `group/nav flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg ${FOCUS_RING}`

/**
 * 34px bucket header: a project, Unfiled, the Archived shelf. The wash hangs
 * off the header row (`group/head`) so it holds while the pointer is over the
 * row's hover actions, which are siblings of this button.
 */
const BUCKET_ROW = `flex h-[34px] min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors group-hover/head:bg-fg/5 ${FOCUS_RING}`

/** 32px session row; its left padding carries the indent. */
const COMPACT_ROW = `flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md pr-2.5 text-left text-[13.5px] transition-colors ${FOCUS_RING}`

/** Cards read as two lines: where the session lives and when, then its title. */
const CARD_ROW = `flex min-w-0 flex-1 flex-col justify-center gap-1 rounded-lg px-2.5 py-2 text-left transition-colors ${FOCUS_RING}`

/** Ink for a row that is neither selected nor current; the wash follows the whole row. */
const ROW_IDLE = 'text-fg-muted group-hover/row:bg-fg/5 group-hover/row:text-fg'

/** Hover cluster that takes over the age / status slot. */
const ROW_ACTION_CLUSTER =
  'absolute right-1.5 flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100'

/** The destructive step of an inline confirmation. */
const DANGER_BUTTON = `inline-flex h-6 shrink-0 items-center rounded-sm bg-danger px-2 text-xs font-medium text-fg-on-accent transition-colors hover:bg-danger-hover ${FOCUS_RING}`

/** A text-only action inside a banner or the selection bar. */
const INLINE_BUTTON = `inline-flex h-6 shrink-0 items-center rounded-sm px-2 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function SelectMark({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex size-3.5 items-center justify-center rounded-[4px] border ${
        checked ? 'border-fg bg-fg text-bg' : 'border-border-strong bg-transparent'
      }`}
    >
      {checked ? <Check size={10} strokeWidth={2.5} aria-hidden /> : null}
    </span>
  )
}

/**
 * The titlebar's leading zone: the wordmark, then search and collapse. The
 * zone is a window drag region, so only the buttons opt out of dragging. A
 * plain `div`: it sits inside the titlebar's `<header>`, which may not hold
 * another one.
 */
export function SidebarHeader({
  onSearch,
  onCollapse,
}: {
  onSearch?: () => void
  onCollapse?: () => void
}) {
  return (
    <div className="flex h-[var(--ari-titlebar-height)] shrink-0 items-center px-3">
      <div className="flex min-w-0 flex-1 items-baseline pl-2">
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
            className={iconButton}
            style={NO_DRAG}
          >
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
        {onCollapse !== undefined ? (
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (Ctrl+B)"
            onClick={onCollapse}
            className={iconButton}
            style={NO_DRAG}
          >
            <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
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

/** The card's right-hand status: phase → one quiet word and the full hint. */
function activityStatus(activity: SessionActivity): { label: string; hint: string } {
  switch (activity.phase) {
    case 'queued':
      return { label: 'Queued', hint: 'Queued' }
    case 'working':
      return { label: 'Working', hint: 'Working' }
    case 'paused':
      return activity.pauseReason === 'approval'
        ? { label: 'Approval', hint: 'Waiting for your approval' }
        : activity.pauseReason === 'input'
          ? { label: 'Input', hint: 'Waiting for your input' }
          : { label: 'Waiting', hint: 'Waiting for you' }
    case 'done':
      return { label: 'Done', hint: 'Turn complete' }
    case 'error':
      return { label: 'Failed', hint: 'Turn failed' }
  }
}

/** Repaints the turn's age on the shared clock without a React render. */
function ElapsedSince({ startedAt }: { startedAt: number }) {
  const ref = useTickingText<HTMLSpanElement>(
    (now) => formatRelativeTime(startedAt, now),
    startedAt,
  )
  return (
    <span ref={ref} className="tabular-nums">
      now
    </span>
  )
}

/**
 * The words beside a card's status glyph, in the caption ink: how long a
 * thread has been running, or why it stopped (the glyph alone cannot tell an
 * approval from a question). Colour stays with the glyph.
 */
function ActivityStatus({ activity }: { activity: SessionActivity }) {
  const status = activityStatus(activity)
  // The forging mark already says a thread is running. A "Working" word beside
  // it just competes with the card.
  if (activity.phase === 'working') {
    if (activity.startedAt === null) return null
    return (
      <span title={status.hint}>
        <ElapsedSince startedAt={activity.startedAt} />
      </span>
    )
  }
  return <span title={status.hint}>{status.label}</span>
}

function SessionRow({
  session,
  hasChildren = false,
  childCount = 0,
  lastAtDepth = NO_DEPTH,
  childToggle,
  childrenShown = false,
  projectName,
  host,
  isActive,
  activity,
  startedByAria = false,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onOpenInSplit,
  selecting = false,
  selected = false,
  variant = 'compact',
  onToggleSelect,
}: {
  session: SessionSummary
  hasChildren?: boolean
  childCount?: number
  /** One entry per level of nesting; drives the indent and the tree line. */
  lastAtDepth?: readonly boolean[]
  /** Present where the row's children can be folded away (the project tree). */
  childToggle?: { expanded: boolean; onToggle: () => void }
  /** True while the children are listed right under the row. */
  childrenShown?: boolean
  /** Origin project, surfaced as a tooltip in flat lists (search, archived, sessions view). */
  projectName: string | null
  host?: { name: string; status: string; readOnly: boolean; administrationReason?: string }
  isActive: boolean
  activity?: SessionActivity
  startedByAria?: boolean
  /** `card` is the Sessions inbox row; compact stays the tree/shelf row. */
  variant?: 'compact' | 'card'
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleArchive: (id: string, archived: boolean) => void
  /** Omit where there is no split view to open one in; the row then just lists. */
  onOpenInSplit?: (id: string, edge: PaneEdge) => void
  selecting?: boolean
  selected?: boolean
  onToggleSelect?: (id: string, shiftKey: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menu = useContextMenu()
  const compact = variant !== 'card'
  const depth = lastAtDepth.length
  // Where the title starts: under the project name, one column in per level.
  const indent = compact ? ROW_INDENT_PX + depth * TREE_COL_PX : ROW_INSET_PX

  if (editing) {
    return (
      // The field's own inset (border + padding) is taken off the indent so
      // the text being edited stays exactly where the title was.
      <div
        className="relative flex h-8 items-center gap-1 pr-1.5"
        style={{ paddingLeft: indent - 7 }}
      >
        <SessionTreeGuides lastAtDepth={lastAtDepth} />
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
          className="h-6 min-w-0 flex-1 rounded-sm border border-border-strong bg-surface-1 px-1.5 text-[13.5px] text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        />
        <button
          type="button"
          aria-label="Confirm rename"
          onClick={() => {
            if (draft.trim()) onRename(session.id, draft.trim())
            setEditing(false)
          }}
          className={rowAction}
        >
          <Check size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Cancel rename"
          onClick={() => {
            setDraft(session.title)
            setEditing(false)
          }}
          className={rowAction}
        >
          <X size={13} aria-hidden />
        </button>
      </div>
    )
  }

  if (confirmDelete) {
    return (
      <div
        className="relative flex h-8 items-center gap-2 rounded-md bg-danger-subtle pr-1.5"
        style={{ paddingLeft: indent }}
      >
        <SessionTreeGuides lastAtDepth={lastAtDepth} />
        <span className="min-w-0 flex-1 truncate text-xs text-danger">
          {hasChildren ? 'Delete this session and its children?' : 'Delete session?'}
        </span>
        <button
          type="button"
          aria-label="Confirm delete"
          onClick={() => onDelete(session.id)}
          className={DANGER_BUTTON}
        >
          Delete
        </button>
        <button
          type="button"
          aria-label="Cancel delete"
          onClick={() => setConfirmDelete(false)}
          className={rowAction}
        >
          <X size={13} aria-hidden />
        </button>
      </div>
    )
  }

  // The select-mode checkbox sits ahead of the row and pushes it right; the
  // tree line and the fold control follow it.
  const shift = selecting ? SELECT_COL_PX : 0
  const current = selected || isActive

  // Quiet marks after the title: who started it, and whether it is pinned.
  // The age / status slot at the right is the only thing that changes state.
  const titleMarks = (
    <>
      {startedByAria ? <AriaMark size={12} className="shrink-0" title="Started by Aria" /> : null}
      {session.pinned ? <Pin size={11} aria-hidden className="shrink-0 text-fg-subtle" /> : null}
      {/* A session on another machine says which, in the same quiet ink as a pin. */}
      {host ? (
        <span
          className={cx('flex shrink-0', host.readOnly ? 'text-warning' : 'text-fg-subtle')}
          title={`${host.name} · ${host.status}`}
        >
          <Monitor size={11} aria-hidden />
          <span className="sr-only">
            On {host.name}
            {host.status === 'connected' ? '' : `, ${host.status}`}
          </span>
        </span>
      ) : null}
    </>
  )

  return (
    <div
      className="group/row relative flex items-center"
      data-session-role={hasChildren ? 'parent' : session.parentSessionId ? 'child' : undefined}
    >
      <SessionTreeGuides lastAtDepth={lastAtDepth} offset={shift} />
      {/* In the gutter where a project keeps its tile. Quiet until the row is
          hovered, and held visible while folded so hidden children are not
          forgotten. A sibling of the row button, so it never selects. */}
      {childToggle ? (
        <button
          type="button"
          aria-label={
            childToggle.expanded
              ? `Collapse children of ${session.title}`
              : `Expand children of ${session.title}`
          }
          aria-expanded={childToggle.expanded}
          className={cx(
            'absolute top-1/2 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-sm text-fg-subtle transition-[color,opacity] hover:text-fg',
            FOCUS_RING,
            childToggle.expanded &&
              'opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100',
          )}
          style={{ left: shift + ROW_INSET_PX + depth * TREE_COL_PX }}
          onClick={childToggle.onToggle}
          onKeyDown={(event) => {
            if (
              (event.key === 'ArrowLeft' && childToggle.expanded) ||
              (event.key === 'ArrowRight' && !childToggle.expanded)
            ) {
              event.preventDefault()
              childToggle.onToggle()
            }
          }}
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={`transition-transform duration-150 ${childToggle.expanded ? 'rotate-90' : ''}`}
          />
        </button>
      ) : null}
      {selecting ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${session.title}`}
          onClick={(e) => onToggleSelect?.(session.id, e.shiftKey)}
          className={`flex size-6 shrink-0 items-center justify-center rounded-sm ${FOCUS_RING}`}
        >
          <SelectMark checked={selected} />
        </button>
      ) : null}
      <button
        type="button"
        // A row dragged into the pane area opens there; the drag carries only
        // the session, so nothing about this list has to know about panes.
        // Select mode owns the click, so the row is not a drag source then.
        draggable={!selecting}
        onDragStart={selecting ? undefined : (e) => setDragSession(e, session.id, session.title)}
        onClick={(e) => {
          if (selecting) {
            onToggleSelect?.(session.id, e.shiftKey)
            return
          }
          onSelect(session.id)
        }}
        onContextMenu={(e) => menu.open(session.id, e)}
        title={projectName ?? undefined}
        className={cx(compact ? COMPACT_ROW : CARD_ROW, current ? rowSelected : ROW_IDLE)}
        style={compact ? { paddingLeft: indent } : undefined}
      >
        {compact ? (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate">{session.title}</span>
              {titleMarks}
              {/* A folded parent says how many it is holding; once the children
                  are listed underneath, the number is for screen readers only. */}
              {hasChildren && childCount > 0 ? (
                <span
                  className={
                    childrenShown ? 'sr-only' : 'shrink-0 text-xs tabular-nums text-fg-subtle'
                  }
                >
                  {childCount}
                </span>
              ) : null}
            </span>
            {/* Age, or the status glyph while the session has something to
                say. min-w-11 matches the two-icon hover cluster so a long title
                truncates before the overlay instead of running under it. */}
            <span className="flex min-w-11 shrink-0 items-center justify-end text-xs tabular-nums text-fg-subtle transition-opacity group-hover/row:opacity-0">
              {activity !== undefined ? (
                <SessionActivityMark activity={activity} />
              ) : (
                formatRelativeTime(session.updatedAt)
              )}
            </span>
          </>
        ) : (
          <>
            {/* Where and who first, quietly: the state or Aria's mark, the
                project, the agent, then the age. The title gets its own line. */}
            <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {activity !== undefined ? (
                  <SessionActivityMark activity={activity} />
                ) : startedByAria ? (
                  <AriaMark size={12} title="Started by Aria" />
                ) : (
                  <span aria-hidden className="ari-status" data-status="idle" />
                )}
              </span>
              {host ? <span className="max-w-20 shrink-0 truncate">{host.name} /</span> : null}
              <span className="min-w-0 shrink truncate">{projectName ?? 'Unfiled'}</span>
              {session.driverKind ? (
                <span
                  className="flex shrink-0 opacity-70 [&>span]:bg-transparent"
                  title={driverLabel(session.driverKind)}
                >
                  <ProviderLogo kind={session.driverKind} size={12} />
                </span>
              ) : null}
              {session.branch ? (
                <span
                  className="flex min-w-0 shrink-[2] items-center gap-1"
                  title={session.workspacePath ?? session.branch}
                >
                  <GitBranch size={11} aria-hidden className="shrink-0 opacity-70" />
                  <span className="min-w-0 truncate">{session.branch}</span>
                </span>
              ) : null}
              <span className="min-w-1 flex-1" />
              <span className="flex shrink-0 items-center gap-1.5 tabular-nums transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0">
                {activity !== undefined ? (
                  <ActivityStatus activity={activity} />
                ) : (
                  formatRelativeTime(session.updatedAt)
                )}
              </span>
            </span>
            <span className="flex w-full min-w-0 items-center gap-1.5 text-[13.5px] font-medium text-fg">
              <span className="min-w-0 truncate">{session.title}</span>
              {session.pinned ? (
                <Pin size={11} aria-hidden className="shrink-0 text-fg-subtle" />
              ) : null}
              {host ? (
                <span className="sr-only">
                  On {host.name}
                  {host.status === 'connected' ? '' : `, ${host.status}`}
                </span>
              ) : null}
            </span>
          </>
        )}
      </button>
      {/* Sibling, not nested: a control inside a <button> is invalid HTML and
          breaks keyboard semantics. Right-click anywhere on the row opens the
          same menu; this is just the discoverable affordance. It takes over the
          timestamp slot while the row is hovered. Archive is a one-press
          sibling so parking a chat does not take a trip through the menu. */}
      <div className={cx(ROW_ACTION_CLUSTER, !compact && 'top-[7px]')}>
        {!session.archived && !selecting ? (
          <button
            type="button"
            aria-label={`Archive ${session.title}`}
            title="Archive"
            disabled={Boolean(host?.administrationReason || host?.readOnly)}
            onClick={() => onToggleArchive(session.id, true)}
            className={rowAction}
          >
            <Archive size={14} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Session actions for ${session.title}`}
          onClick={(e) => menu.open(session.id, e)}
          className={rowAction}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </div>
      {menu.openFor === session.id ? (
        <ContextMenu
          anchor={menu.anchor}
          label={`Session actions for ${session.title}`}
          onClose={menu.close}
          items={[
            // The drag gestures' discoverable twin: same two moves, one click.
            ...(onOpenInSplit
              ? ([
                  {
                    id: 'split-right',
                    label: 'Open in split right',
                    icon: PanelRight,
                    onSelect: () => onOpenInSplit(session.id, 'right'),
                  },
                  {
                    id: 'split-below',
                    label: 'Open in split below',
                    icon: PanelBottom,
                    onSelect: () => onOpenInSplit(session.id, 'below'),
                  },
                ] as ContextMenuItem[])
              : []),
            {
              id: 'pin',
              label: session.pinned ? 'Unpin' : 'Pin to top',
              icon: session.pinned ? PinOff : Pin,
              disabled: host?.readOnly,
              disabledReason: host?.readOnly
                ? 'Reconnect the owning machine to change this session.'
                : undefined,
              onSelect: () => onTogglePin(session.id, !session.pinned),
            },
            {
              id: 'rename',
              label: 'Rename',
              icon: Pencil,
              disabled: host?.readOnly,
              disabledReason: host?.readOnly
                ? 'Reconnect the owning machine to rename this session.'
                : undefined,
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
              disabled: Boolean(host?.administrationReason || host?.readOnly),
              disabledReason:
                host?.administrationReason ??
                (host?.readOnly ? 'Reconnect the owning machine.' : undefined),
              onSelect: () => onToggleArchive(session.id, !session.archived),
            },
            {
              id: 'delete',
              label: hasChildren ? 'Delete session and children' : 'Delete session',
              icon: Trash2,
              danger: true,
              disabled: Boolean(host?.administrationReason || host?.readOnly),
              disabledReason:
                host?.administrationReason ??
                (host?.readOnly ? 'Reconnect the owning machine.' : undefined),
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
  startedByAria?: (id: string) => boolean
  activeSessionId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleArchive: (id: string, archived: boolean) => void
  /** Opens a session in a new pane; absent when no split view is mounted. */
  onOpenInSplit?: (id: string, edge: PaneEdge) => void
  /** Live working/paused/done overlay; omit in tests that only cover listing. */
  activityOf?: (sessionId: string) => SessionActivity | undefined
  hostOf?: (
    sessionId: string,
  ) =>
    { name: string; status: string; readOnly: boolean; administrationReason?: string } | undefined
  selecting?: boolean
  selectedIds?: ReadonlySet<string>
  onToggleSelect?: (id: string, shiftKey: boolean) => void
  onArchiveMany?: (ids: string[]) => void
  onDeleteMany?: (ids: string[]) => void
}

/** Direct, non-archived children. Cards use this for delete copy, not for a second row. */
function directChildCount(scope: readonly SessionSummary[], id: string): number {
  let count = 0
  for (const session of scope) {
    if (!session.archived && session.parentSessionId === id) count += 1
  }
  return count
}

/** FLIP-animated session list; shared by groups, the archived shelf and search. */
function SessionList({
  sessions,
  searching = false,
  projectNameOf,
  handlers,
  variant = 'compact',
  flat = false,
  activityScope,
}: {
  sessions: SessionSummary[]
  searching?: boolean
  projectNameOf?: (projectId: string) => string | null
  handlers: SessionRowHandlers
  /** Card rows for the Sessions inbox. The same card is used while a thread runs. */
  variant?: 'compact' | 'card'
  /** Render every session as its own thread, with no tree guides or chevrons. */
  flat?: boolean
  /**
   * Sessions consulted for child counts and folded activity. The Sessions
   * inbox renders roots only, so this is the full live list while `sessions`
   * is just the cards on screen.
   */
  activityScope?: readonly SessionSummary[]
}) {
  const { collapsed, toggle } = useSessionCollapse()
  const scope = activityScope ?? sessions
  const rows = flat
    ? sessions.map((session) => ({
        session,
        childCount: directChildCount(scope, session.id),
        lastAtDepth: [] as boolean[],
      }))
    : sessionTree(sessions, searching ? new Set() : collapsed)
  const order = rows.map((row) => row.session.id).join(' ')
  return (
    <ul className={`flex flex-col ${variant === 'card' ? 'gap-0.5' : 'gap-px'}`}>
      {rows.map(({ session: s, childCount, lastAtDepth }) => {
        const expanded = !collapsed.has(s.id)
        const rowVariant =
          variant === 'card' && (flat || lastAtDepth.length === 0) ? 'card' : 'compact'
        const foldable = childCount > 0 && !searching && !flat
        return (
          <motion.li key={s.id} {...LIST_LAYOUT} layoutDependency={order}>
            <SessionRow
              session={s}
              startedByAria={handlers.startedByAria?.(s.id)}
              hasChildren={childCount > 0}
              childCount={childCount}
              lastAtDepth={lastAtDepth}
              childToggle={foldable ? { expanded, onToggle: () => toggle(s.id) } : undefined}
              childrenShown={!flat && (searching || expanded)}
              variant={rowVariant}
              projectName={projectNameOf?.(s.projectId) ?? null}
              host={handlers.hostOf?.(s.id)}
              isActive={s.id === handlers.activeSessionId}
              activity={treeActivity(
                handlers.activityOf?.(s.id),
                descendantIds(scope, s.id).map((id) => handlers.activityOf?.(id)),
              )}
              onSelect={handlers.onSelect}
              onRename={handlers.onRename}
              onDelete={handlers.onDelete}
              onTogglePin={handlers.onTogglePin}
              onToggleArchive={handlers.onToggleArchive}
              onOpenInSplit={handlers.onOpenInSplit}
              selecting={handlers.selecting}
              selected={handlers.selectedIds?.has(s.id) ?? false}
              onToggleSelect={handlers.onToggleSelect}
            />
          </motion.li>
        )
      })}
    </ul>
  )
}

/** Collapsible global shelf (Archived) — collapsed until summoned. */
function CollapsibleSessions({
  label,
  sessions,
  projectNameOf,
  handlers,
  onRestoreAll,
  onEmptyArchive,
}: {
  label: string
  sessions: SessionSummary[]
  projectNameOf: (projectId: string) => string | null
  handlers: SessionRowHandlers
  onRestoreAll?: () => void
  onEmptyArchive?: () => void
}) {
  const [open, setOpen] = useState(sessions.some((s) => s.id === handlers.activeSessionId))
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const menu = useContextMenu()

  // Auto-open when the active session moves into this bucket.
  useEffect(() => {
    if (sessions.some((s) => s.id === handlers.activeSessionId)) setOpen(true)
  }, [handlers.activeSessionId, sessions])

  // The shelf sits at the bottom of the scroll pane, so opening it would push
  // its rows past the fold; pull them back into view.
  useEffect(() => {
    if (open) contentRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open])

  // The shelf keeps the active-location signal: its caret fills while the
  // active session sits inside, even though the shelf opens on its own.
  const shelfActive =
    handlers.activeSessionId != null && sessions.some((s) => s.id === handlers.activeSessionId)

  return (
    <div>
      <div className="group/head relative flex items-center">
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          onContextMenu={(e) => menu.open('archived', e)}
          className={`${BUCKET_ROW} text-fg-muted group-hover/head:text-fg`}
        >
          <ContextMark variant="archived" active={shelfActive} />
          <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
          {/* Like a project, the shelf counts what it holds only while shut. */}
          <span className="flex min-w-6 shrink-0 justify-end text-xs tabular-nums text-fg-subtle transition-opacity group-hover/head:opacity-0">
            {open ? null : sessions.length}
          </span>
        </button>
        <button
          type="button"
          aria-label="Archived session actions"
          onClick={(e) => menu.open('archived', e)}
          className={`${rowAction} absolute right-1.5 opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100`}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </div>
      {menu.openFor === 'archived' ? (
        <ContextMenu
          anchor={menu.anchor}
          label="Archived session actions"
          onClose={menu.close}
          items={[
            {
              id: 'restore-all',
              label: 'Restore all',
              icon: ArchiveRestore,
              onSelect: () => onRestoreAll?.(),
            },
            {
              id: 'empty',
              label: 'Empty archive',
              icon: Trash2,
              danger: true,
              onSelect: () => setConfirmEmpty(true),
            },
          ]}
        />
      ) : null}
      {confirmEmpty ? (
        <ProjectNotice
          tone="danger"
          label={`Delete ${sessions.length} archived session${sessions.length === 1 ? '' : 's'}?`}
        >
          <button
            type="button"
            aria-label="Confirm empty archive"
            onClick={() => {
              setConfirmEmpty(false)
              onEmptyArchive?.()
            }}
            className={DANGER_BUTTON}
          >
            Delete
          </button>
          <button
            type="button"
            aria-label="Keep archived sessions"
            onClick={() => setConfirmEmpty(false)}
            className={rowAction}
          >
            <X size={13} aria-hidden />
          </button>
        </ProjectNotice>
      ) : null}
      {/* Closing is instant: an exit fade would hold the space open and keep
          everything below from moving up until it finished. */}
      {open ? (
        <div ref={contentRef} className="ari-enter-fade pt-px">
          <SessionList sessions={sessions} projectNameOf={projectNameOf} handlers={handlers} />
        </div>
      ) : null}
    </div>
  )
}

/** A project as the sidebar needs it: identity plus live folder status. */
export interface SidebarProject {
  id: string
  name: string
  path?: string
  status?: ProjectStatus
  hostLabel?: string
  localProjectId?: string
  localActions?: boolean
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
  bulk,
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
  bulk?: {
    administrationReason?: string
    selecting: boolean
    selectedCount: number
    allSelected: boolean
    onEnterSelect: () => void
    onToggleSelectAll: () => void
    onArchiveAll: () => void
    onDeleteAll: () => void
  }
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const menu = useContextMenu()
  const menuId = project?.id ?? UNFILED_GROUP_ID
  const empty = sessions.length === 0
  const allSelected = bulk?.allSelected ?? false
  const scope = project ? 'this project' : 'Unfiled'
  // Distinguishes the click that follows a header release from the drag that
  // started on it: only a press that did not travel toggles the group.
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const missing = project?.status === 'missing'
  const localActions = project?.localActions !== false
  const groupActivity = peakActivity(sessions.map((s) => handlers.activityOf?.(s.id)))
  const isActiveGroup = sessions.some((s) => s.id === handlers.activeSessionId)
  // An open group shows each session's own glyph, so the header stays bare
  // unless something inside needs the user. Folded, it speaks for its rows:
  // their peak status and how many there are. Both stay in the tree for
  // screen readers either way.
  const showActivity = !expanded || groupActivity?.phase === 'paused'
  const showCount = !expanded || bulk?.selecting === true

  return (
    <section aria-label={name}>
      <div data-active-group={isActiveGroup ? '' : undefined}>
        <div className="group/head relative flex items-center">
          {bulk?.selecting ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={allSelected}
              aria-label={`Select all sessions in ${name}`}
              onClick={bulk.onToggleSelectAll}
              className={`flex size-6 shrink-0 items-center justify-center rounded-sm ${FOCUS_RING}`}
            >
              <SelectMark checked={allSelected} />
            </button>
          ) : null}
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
            onContextMenu={(e) => menu.open(menuId, e)}
            className={cx(BUCKET_ROW, missing && 'opacity-60')}
          >
            <ContextMark
              variant={project ? 'project' : 'unfiled'}
              open={expanded}
              active={isActiveGroup}
            />
            <span
              className={`min-w-0 flex-1 truncate text-sm font-medium ${
                missing ? 'text-fg-subtle line-through' : 'text-fg'
              }`}
            >
              {name}
            </span>
            {/* min-w-11 keeps a long name clear of the hover actions. */}
            <span className="flex min-w-11 shrink-0 items-center justify-end gap-1.5 transition-opacity group-hover/head:opacity-0">
              {project?.hostLabel ? (
                <span
                  className="flex max-w-24 items-center gap-1 text-xs text-fg-subtle"
                  title={project.hostLabel}
                >
                  <Monitor size={11} aria-hidden className="shrink-0" />
                  <span className="truncate">{project.hostLabel}</span>
                </span>
              ) : null}
              {groupActivity !== undefined ? (
                <span className={showActivity ? 'flex' : 'sr-only'}>
                  <SessionActivityMark activity={groupActivity} />
                </span>
              ) : null}
              <span className={showCount ? 'text-xs tabular-nums text-fg-subtle' : 'sr-only'}>
                {bulk?.selecting
                  ? `${String(bulk.selectedCount)}/${String(sessions.length)}`
                  : sessions.length}
              </span>
            </span>
          </button>
          <div className="absolute right-1.5 flex items-center opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100">
            {project ? (
              <button
                type="button"
                aria-label={`New session in ${name}`}
                title="New session here"
                onClick={() => actions.onNewSessionInProject?.(project.id)}
                className={rowAction}
              >
                <Plus size={14} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={project ? `Project actions for ${name}` : 'Unfiled session actions'}
              onClick={(e) => menu.open(menuId, e)}
              className={rowAction}
            >
              <MoreHorizontal size={14} aria-hidden />
            </button>
          </div>
        </div>
        {menu.openFor === menuId ? (
          <ContextMenu
            anchor={menu.anchor}
            label={project ? `Project actions for ${name}` : 'Unfiled session actions'}
            onClose={menu.close}
            items={[
              ...(project
                ? ([
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
                      disabled: missing || !localActions,
                      disabledReason: missing
                        ? 'Locate this project before importing sessions'
                        : undefined,
                      onSelect: () => actions.onImportSessions?.(project.id),
                    },
                    {
                      id: 'reveal',
                      label: 'Reveal in file manager',
                      icon: FolderOpen,
                      disabled: !localActions,
                      onSelect: () => actions.onRevealProject?.(project.id),
                    },
                    {
                      id: 'move-up',
                      label: 'Move up',
                      icon: ArrowUp,
                      disabled: !canMoveUp || !localActions,
                      disabledReason: canMoveUp ? undefined : 'Already the top project',
                      onSelect: () => actions.onMoveProject?.(project.id, -1),
                    },
                    {
                      id: 'move-down',
                      label: 'Move down',
                      icon: ArrowDown,
                      disabled: !canMoveDown || !localActions,
                      disabledReason: canMoveDown ? undefined : 'Already the last project',
                      onSelect: () => actions.onMoveProject?.(project.id, 1),
                    },
                    {
                      id: 'close',
                      label: 'Close project',
                      icon: X,
                      disabled: !localActions,
                      onSelect: () => actions.onCloseProject?.(project.id),
                    },
                    {
                      id: 'remove',
                      label: 'Remove project',
                      icon: Trash2,
                      danger: true,
                      disabled: !localActions,
                      onSelect: () => setConfirmRemove(true),
                    },
                  ] as ContextMenuItem[])
                : []),
              {
                id: 'select',
                label: 'Select sessions',
                icon: Check,
                disabled: empty,
                disabledReason: empty ? 'No sessions in this group' : undefined,
                onSelect: () => bulk?.onEnterSelect(),
              },
              {
                id: 'archive-all',
                label: `Archive all in ${scope}`,
                icon: Archive,
                disabled: empty || Boolean(bulk?.administrationReason),
                disabledReason:
                  bulk?.administrationReason ?? (empty ? 'No sessions in this group' : undefined),
                onSelect: () => bulk?.onArchiveAll(),
              },
              {
                id: 'delete-all',
                label: `Delete all in ${scope}`,
                icon: Trash2,
                danger: true,
                disabled: empty || Boolean(bulk?.administrationReason),
                disabledReason:
                  bulk?.administrationReason ?? (empty ? 'No sessions in this group' : undefined),
                onSelect: () => setConfirmDeleteAll(true),
              },
            ]}
          />
        ) : null}
        {confirmDeleteAll ? (
          <ProjectNotice
            tone="danger"
            label={`Delete ${sessions.length} session${sessions.length === 1 ? '' : 's'} in ${scope}?`}
          >
            <button
              type="button"
              aria-label={`Confirm delete all in ${name}`}
              onClick={() => {
                setConfirmDeleteAll(false)
                bulk?.onDeleteAll()
              }}
              className={DANGER_BUTTON}
            >
              Delete
            </button>
            <button
              type="button"
              aria-label={`Keep sessions in ${name}`}
              onClick={() => setConfirmDeleteAll(false)}
              className={rowAction}
            >
              <X size={13} aria-hidden />
            </button>
          </ProjectNotice>
        ) : null}
        {project && confirmRemove ? (
          <ProjectNotice tone="danger" label="Remove project?">
            <button
              type="button"
              aria-label={`Confirm remove ${name}`}
              onClick={() => {
                setConfirmRemove(false)
                actions.onRemoveProject?.(project.id)
              }}
              className={DANGER_BUTTON}
            >
              Remove
            </button>
            <button
              type="button"
              aria-label={`Keep ${name}`}
              onClick={() => setConfirmRemove(false)}
              className={rowAction}
            >
              <X size={13} aria-hidden />
            </button>
          </ProjectNotice>
        ) : null}
        {project && missing ? (
          <ProjectNotice tone="muted" label="folder missing">
            <button
              type="button"
              onClick={() => actions.onLocateProject?.(project.id)}
              className={`${INLINE_BUTTON} text-fg hover:bg-fg/9`}
            >
              Locate
            </button>
            <button
              type="button"
              onClick={() => actions.onCloseProject?.(project.id)}
              className={`${INLINE_BUTTON} text-fg-muted hover:bg-fg/9 hover:text-fg`}
            >
              Close
            </button>
          </ProjectNotice>
        ) : null}
        {/* The gap under an open group is what separates it from the next
            project; there is no rule between them. */}
        {expanded ? (
          sessions.length > 0 ? (
            <div className="pb-2 pt-px">
              <SessionList sessions={sessions} handlers={handlers} />
            </div>
          ) : (
            <p
              className="mb-2 flex h-8 items-center text-xs text-fg-subtle"
              style={{ paddingLeft: ROW_INDENT_PX }}
            >
              No sessions yet.
            </p>
          )
        ) : null}
      </div>
    </section>
  )
}

/**
 * A one-line banner under a project header — the remove confirmation, the
 * missing-folder prompt. The inset and the gap underneath are the point: flush
 * and edge to edge, its rounded corners meet the active session row's
 * highlight and the two read as one connected shape instead of a banner.
 */
function ProjectNotice({
  tone,
  label,
  children,
}: {
  tone: 'danger' | 'muted'
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      className={`mx-2 mb-1 flex h-8 items-center gap-1 rounded-md pl-2.5 pr-1 ${
        tone === 'danger' ? 'bg-danger-subtle' : 'bg-fg/5'
      }`}
    >
      <span
        className={`min-w-0 flex-1 truncate text-xs ${
          tone === 'danger' ? 'text-danger' : 'text-fg-muted'
        }`}
      >
        {label}
      </span>
      {children}
    </div>
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
  bulk,
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
  bulk?: {
    administrationReason?: string
    selecting: boolean
    selectedCount: number
    allSelected: boolean
    onEnterSelect: () => void
    onToggleSelectAll: () => void
    onArchiveAll: () => void
    onDeleteAll: () => void
  }
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
        bulk={bulk}
      />
    </Reorder.Item>
  )
}

type SessionsUnderProjectsProps = SessionRowHandlers &
  ProjectActions & {
    sessions: SessionSummary[]
    projects: SidebarProject[]
    /** Every known project (open or not), so archived/search rows keep their origin chip. */
    knownProjectNames?: { id: string; name: string }[]
    /** Opens the native folder picker; a cancel is a silent no-op. */
    onOpenProject?: () => void
    /** Anchors the project picker the new session will run in, under the button. */
    onNewSession?: (anchor: MenuAnchor) => void
    searchInputRef?: Ref<HTMLInputElement>
    /** Controlled search query; owned by the shell so it survives this list unmounting. */
    searchQuery?: string
    onSearchQueryChange?: (query: string) => void
  }

/**
 * Sidebar body: a compose row, then either the Projects view (one collapsible
 * group per open project with its sessions nested inside, pinned first, a
 * trailing Unfiled group, drag-reorderable) or the Sessions view (root threads
 * as cards, running or settled, with child agents kept off this list), plus
 * the global Archived shelf. Searching flattens matches across every project
 * into one list.
 */
export function SessionsUnderProjects(props: SessionsUnderProjectsProps) {
  // The shell re-renders far more often than the sidebar's data changes, and
  // passes inline handlers; every sidebar render re-measures each
  // drag-reorderable project group. Stable handlers let the memo hold.
  return <SessionsUnderProjectsBody {...useStableHandlers(props)} />
}

const SessionsUnderProjectsBody = memo(function SessionsUnderProjectsBody({
  sessions: allSessions,
  projects: allProjects,
  activeSessionId,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onArchiveMany,
  onDeleteMany,
  onOpenInSplit,
  activityOf,
  hostOf,
  startedByAria,
  onOpenProject,
  onNewSession,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  knownProjectNames,
  ...actions
}: SessionsUnderProjectsProps) {
  const sessions = useMemo(() => visibleSessions(allSessions), [allSessions])
  const projects = useMemo(() => visibleProjects(allProjects), [allProjects])
  const [localQuery, setLocalQuery] = useState('')
  const query = searchQuery ?? localQuery
  const setQuery = onSearchQueryChange ?? setLocalQuery
  const trimmed = query.trim().toLowerCase()
  const { isExpanded, toggle } = useProjectExpand()
  const { view, setView } = useSidebarView()
  const [selectingGroupId, setSelectingGroupId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [lastSelectId, setLastSelectId] = useState<string | null>(null)
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false)

  const archiveOne = (id: string, archived: boolean): void => {
    if (hostOf?.(id)?.administrationReason || hostOf?.(id)?.readOnly) return
    if (!archived) {
      onToggleArchive(id, false)
      return
    }
    const ids = archiveTargetIds(sessions, id)
    if (onArchiveMany) onArchiveMany(ids)
    else for (const target of ids) onToggleArchive(target, true)
  }

  const handlers: SessionRowHandlers = {
    startedByAria,
    activeSessionId,
    onSelect,
    onRename,
    onDelete,
    onTogglePin,
    onToggleArchive: archiveOne,
    onOpenInSplit,
    activityOf,
    hostOf,
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
  const sessionsInGroup = (groupId: string): SessionSummary[] =>
    groupId === UNFILED_GROUP_ID
      ? (unfiled?.sessions ?? [])
      : (groups.find((group) => group.id === groupId)?.sessions ?? [])
  const visibleGroupIds = (groupId: string): string[] =>
    sessionTree(sessionsInGroup(groupId)).map((row) => row.session.id)

  const clearSelect = (): void => {
    setSelectingGroupId(null)
    setSelectedIds(new Set())
    setLastSelectId(null)
    setConfirmDeleteSelected(false)
  }

  const enterSelect = (groupId: string): void => {
    if (!isExpanded(groupId)) toggle(groupId)
    setSelectingGroupId(groupId)
    setSelectedIds(new Set())
    setLastSelectId(null)
    setConfirmDeleteSelected(false)
  }

  const toggleSelect = (id: string, shiftKey: boolean): void => {
    if (selectingGroupId === null) return
    const order = visibleGroupIds(selectingGroupId)
    if (!order.includes(id)) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      const add = (target: string): void => {
        next.add(target)
        for (const child of descendantIds(sessions, target)) next.add(child)
      }
      const remove = (target: string): void => {
        next.delete(target)
        for (const child of descendantIds(sessions, target)) next.delete(child)
        const parent = sessions.find((session) => session.id === target)?.parentSessionId
        if (parent !== undefined && parent !== null && next.has(parent)) next.delete(parent)
      }
      if (shiftKey && lastSelectId !== null && order.includes(lastSelectId)) {
        const from = order.indexOf(lastSelectId)
        const to = order.indexOf(id)
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        const adding = !prev.has(id)
        for (let i = lo; i <= hi; i++) {
          const sid = order[i]
          if (sid === undefined) continue
          if (adding) add(sid)
          else remove(sid)
        }
      } else if (prev.has(id)) {
        remove(id)
      } else {
        add(id)
      }
      return next
    })
    setLastSelectId(id)
  }

  const toggleSelectAll = (groupId: string): void => {
    const ids = visibleGroupIds(groupId)
    setSelectedIds((prev) =>
      ids.length > 0 && ids.every((id) => prev.has(id)) ? new Set() : new Set(ids),
    )
  }

  const archiveIds = (ids: string[]): void => {
    if (ids.some((id) => hostOf?.(id)?.administrationReason || hostOf?.(id)?.readOnly)) return
    const expanded = new Set<string>()
    for (const id of ids) for (const target of archiveTargetIds(sessions, id)) expanded.add(target)
    const list = [...expanded]
    if (onArchiveMany) onArchiveMany(list)
    else for (const id of list) onToggleArchive(id, true)
    clearSelect()
  }

  const deleteIds = (ids: string[]): void => {
    if (ids.some((id) => hostOf?.(id)?.administrationReason || hostOf?.(id)?.readOnly)) return
    const roots = selectionRoots(sessions, new Set(ids))
    if (onDeleteMany) onDeleteMany(roots)
    else for (const id of roots) onDelete(id)
    clearSelect()
  }

  const bulkFor = (groupId: string) => {
    const visible = visibleGroupIds(groupId)
    const selecting = selectingGroupId === groupId
    return {
      selecting,
      administrationReason: visible.some(
        (id) => hostOf?.(id)?.administrationReason || hostOf?.(id)?.readOnly,
      )
        ? 'Session administration is unavailable for one or more owning hosts.'
        : undefined,
      selectedCount: selecting ? visible.filter((id) => selectedIds.has(id)).length : 0,
      allSelected: selecting && visible.length > 0 && visible.every((id) => selectedIds.has(id)),
      onEnterSelect: () => enterSelect(groupId),
      onToggleSelectAll: () => toggleSelectAll(groupId),
      onArchiveAll: () => archiveIds(visible),
      onDeleteAll: () => deleteIds(visible),
    }
  }

  const handlersFor = (groupId: string): SessionRowHandlers => ({
    ...handlers,
    selecting: selectingGroupId === groupId,
    selectedIds,
    onToggleSelect: toggleSelect,
  })

  useEffect(() => {
    if (selectingGroupId === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      clearSelect()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectingGroupId])

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
  const matches = useMemo(() => {
    if (!trimmed) return []
    const found = searchSessionTree(sessions, trimmed)
    // Child agents stay inside the parent thread in the Sessions view.
    return view === 'sessions' ? found.filter((session) => !session.parentSessionId) : found
  }, [sessions, trimmed, view])
  // Newest-first shelf of everything archived (the groups exclude them).
  const archived = useMemo(
    () => [...sessions].filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  )
  const inbox = useMemo(() => (view === 'sessions' ? inboxSplit(sessions) : null), [sessions, view])
  // Live sessions, including children that are not drawn as their own cards,
  // so a root card can still chase while a child agent is the one running.
  const liveSessions = useMemo(() => sessions.filter((session) => !session.archived), [sessions])

  const archivedShelf =
    archived.length > 0 ? (
      <div className="mt-2">
        <CollapsibleSessions
          label="Archived"
          sessions={archived}
          projectNameOf={projectNameOf}
          handlers={handlers}
          onRestoreAll={() => {
            for (const session of archived) onToggleArchive(session.id, false)
          }}
          onEmptyArchive={() => deleteIds(archived.map((session) => session.id))}
        />
      </div>
    ) : null

  const body =
    trimmed !== '' ? (
      matches.length === 0 ? (
        <p className="px-2.5 py-6 text-center text-xs text-fg-subtle">
          No sessions match “{query.trim()}”.
        </p>
      ) : (
        <SessionList
          sessions={matches}
          searching
          flat
          variant={view === 'sessions' ? 'card' : 'compact'}
          activityScope={view === 'sessions' ? liveSessions : undefined}
          projectNameOf={projectNameOf}
          handlers={handlers}
        />
      )
    ) : groups.length === 0 && archived.length === 0 ? (
      <p className="px-2.5 py-8 text-center text-xs leading-relaxed text-fg-subtle">
        No sessions yet.
        <br />
        Open a project or start a session.
      </p>
    ) : view === 'sessions' ? (
      <>
        {inbox === null || (inbox.pinned.length === 0 && inbox.active.length === 0) ? (
          <p className="px-2.5 py-6 text-center text-xs text-fg-subtle">No sessions yet.</p>
        ) : (
          <>
            {inbox.pinned.length > 0 ? (
              <section aria-label="Pinned" className="mb-2">
                <h3
                  className={`${sectionLabel} flex h-7 items-center justify-between px-2.5 font-normal`}
                >
                  <span>Pinned</span>
                  <span className="tabular-nums">{inbox.pinned.length}</span>
                </h3>
                <SessionList
                  sessions={inbox.pinned}
                  flat
                  activityScope={liveSessions}
                  projectNameOf={projectNameOf}
                  handlers={handlers}
                  variant="card"
                />
              </section>
            ) : null}
            {inbox.active.length > 0 ? (
              <section aria-label="Active">
                <SessionList
                  sessions={inbox.active}
                  flat
                  activityScope={liveSessions}
                  projectNameOf={projectNameOf}
                  handlers={handlers}
                  variant="card"
                />
              </section>
            ) : null}
          </>
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
          className="flex flex-col gap-px"
        >
          {projectGroups.map((group, index) => (
            <DraggableProjectGroup
              key={group.id}
              group={group}
              project={projects.find((p) => p.id === group.id) ?? null}
              sessions={group.sessions}
              expanded={isExpanded(group.id)}
              onToggle={() => toggle(group.id)}
              handlers={handlersFor(group.id)}
              actions={actions}
              canMoveUp={index > 0}
              canMoveDown={index < projectGroups.length - 1}
              onPressStart={() => (pressedGroupId.current = group.id)}
              bulk={bulkFor(group.id)}
            />
          ))}
        </Reorder.Group>
        {unfiled ? (
          <div className="mt-px">
            <ProjectGroupSection
              name={unfiled.name}
              project={null}
              sessions={unfiled.sessions}
              expanded={isExpanded(UNFILED_GROUP_ID)}
              onToggle={() => toggle(UNFILED_GROUP_ID)}
              handlers={handlersFor(UNFILED_GROUP_ID)}
              actions={actions}
              bulk={bulkFor(UNFILED_GROUP_ID)}
            />
          </div>
        ) : null}
        {archivedShelf}
      </>
    )

  return (
    <>
      <div className="shrink-0 px-2.5">
        <button
          type="button"
          data-new-session-trigger
          aria-label="New session"
          title="New session (Mod+N)"
          onClick={(e) => onNewSession?.(anchorBelow(e.currentTarget))}
          className={NAV_ROW}
        >
          <SquarePen size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">New session</span>
          {/* The shortcut is a hint, not a control: quiet text, shown on reach. */}
          <span className="shrink-0 text-xs text-fg-subtle opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
            Mod+N
          </span>
        </button>
      </div>
      <SidebarSearch query={query} onQueryChange={setQuery} inputRef={searchInputRef} collapsed />
      {/* The list's caption row: which view it is, and the one way to grow it.
          The view switch steps aside while a search flattens the list. */}
      <div className="flex shrink-0 items-center pb-1.5 pl-5 pr-4 pt-4">
        {trimmed === '' ? <SidebarViewSwitch view={view} onChange={setView} /> : null}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Add project"
          title="Add a folder as a project"
          onClick={() => onOpenProject?.()}
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fg/6 hover:text-fg ${FOCUS_RING}`}
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <nav className="ari-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-2" aria-label="Sessions">
        {body}
      </nav>
      {selectingGroupId !== null ? (
        <div
          className={`mx-2.5 mb-1 flex h-9 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1.5 ${
            confirmDeleteSelected ? 'bg-danger-subtle' : 'bg-fg/5'
          }`}
        >
          {confirmDeleteSelected ? (
            <>
              <span className="min-w-0 flex-1 truncate text-xs text-danger">
                {`Delete ${String(selectedIds.size)} session${selectedIds.size === 1 ? '' : 's'}?`}
              </span>
              <button
                type="button"
                aria-label="Confirm delete selected sessions"
                onClick={() => deleteIds([...selectedIds])}
                className={DANGER_BUTTON}
              >
                Delete
              </button>
              <button
                type="button"
                aria-label="Cancel delete selected sessions"
                onClick={() => setConfirmDeleteSelected(false)}
                className={rowAction}
              >
                <X size={13} aria-hidden />
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-fg-muted">
                {`${String(selectedIds.size)} selected`}
              </span>
              <button
                type="button"
                disabled={
                  selectedIds.size === 0 ||
                  [...selectedIds].some(
                    (id) => hostOf?.(id)?.administrationReason || hostOf?.(id)?.readOnly,
                  )
                }
                onClick={() => archiveIds([...selectedIds])}
                className={`${INLINE_BUTTON} text-fg-muted hover:bg-fg/9 hover:text-fg`}
              >
                Archive
              </button>
              <button
                type="button"
                disabled={
                  selectedIds.size === 0 ||
                  [...selectedIds].some(
                    (id) => hostOf?.(id)?.administrationReason || hostOf?.(id)?.readOnly,
                  )
                }
                onClick={() => setConfirmDeleteSelected(true)}
                className={`${INLINE_BUTTON} text-danger hover:bg-danger-subtle`}
              >
                Delete
              </button>
              <button
                type="button"
                aria-label="Cancel session selection"
                onClick={clearSelect}
                className={rowAction}
              >
                <X size={13} aria-hidden />
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  )
})

/**
 * The list's caption doubling as the Projects / Sessions view switch: two
 * words, the current one in full ink. No pills, no track.
 */
function SidebarViewSwitch({
  view,
  onChange,
}: {
  view: SidebarView
  onChange: (view: SidebarView) => void
}) {
  const tab = (id: SidebarView, label: string) => {
    const selected = view === id
    return (
      <button
        key={id}
        type="button"
        aria-pressed={selected}
        onClick={() => onChange(id)}
        className={`rounded-sm text-[12.5px] leading-6 transition-colors ${FOCUS_RING} ${
          selected ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
        }`}
      >
        {label}
      </button>
    )
  }
  return (
    <div role="group" aria-label="Sidebar view" className="flex items-center gap-3">
      {tab('projects', 'Projects')}
      {tab('sessions', 'Sessions')}
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
    <div className={visible ? 'shrink-0 px-2.5 pt-1.5' : 'sr-only'}>
      <div className="relative">
        <Search
          size={14}
          strokeWidth={1.75}
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
          className="h-8 w-full rounded-md border border-border-strong bg-transparent pl-[34px] pr-2.5 text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        />
      </div>
    </div>
  )
}

export type SidebarNavId =
  | 'session'
  | 'terminal'
  | 'browser'
  | 'changes'
  | 'source-control'
  | 'settings'
  | 'files'
  | 'usage'
  | 'github'

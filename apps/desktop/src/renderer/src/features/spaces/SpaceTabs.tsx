import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotionConfig } from 'motion/react'
import { ChevronLeft, ChevronRight, Pencil, Plus, X } from 'lucide-react'
import { EASE_OUT_EXPO } from '@ari/ui/motion'
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../shell/ContextMenu'
import type { DragEvent, KeyboardEvent } from 'react'
import { MAX_SPACES, type Space } from './spaces'
import type { SpaceStatus } from './space-status'

/** Payload type for the tab drag, kept off the pane drags' namespaces. */
const SPACE_MIME = 'application/x-ari-space-id'

export interface SpaceTabsProps {
  spaces: readonly Space[]
  activeSpaceId: string
  statusOf?: (space: Space) => SpaceStatus
  onSelect: (spaceId: string) => void
  onCreate: () => void
  onClose: (spaceId: string) => void
  onRename: (spaceId: string, name: string) => void
  /** Drag-reorder: move `spaceId` in front of `beforeId`, or last when null. */
  onReorder?: (spaceId: string, beforeId: string | null) => void
  /** False at the tab ceiling, where "+" would be refused anyway. */
  canCreate: boolean
}

/**
 * The dot colour and motion per activity phase. The state is also spelled out in
 * the tab's tooltip and its "working" pulse, so colour is never the only cue.
 */
const STATUS_CLASS: Record<Exclude<SpaceStatus, null>, string> = {
  working: 'bg-accent animate-pulse',
  attention: 'bg-warning',
}

const STATUS_LABEL: Record<Exclude<SpaceStatus, null>, string> = {
  working: 'working',
  attention: 'needs attention',
}

/**
 * The strip of space tabs above the pane area. It is the same shape as the
 * terminal rail's tabs and the design-system `Tabs`: a role="tablist" of tabs
 * with a shared active indicator that slides between them. Unlike that
 * component each tab carries a close affordance and can be renamed in place,
 * and the strip stays mounted across the whole workspace rather than owning its
 * panels — the pane area below is one region, not one per tab.
 */
export function SpaceTabs({
  spaces,
  activeSpaceId,
  statusOf,
  onSelect,
  onCreate,
  onClose,
  onRename,
  onReorder,
  canCreate,
}: SpaceTabsProps) {
  const reducedMotion = useReducedMotionConfig()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropBeforeId, setDropBeforeId] = useState<string | null | undefined>(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const menu = useContextMenu()
  const menuSpace = spaces.find((space) => space.id === menu.openFor) ?? null

  // Keep the selected tab in view when it changes from the keyboard or a jump,
  // so a strip that has scrolled does not hide the tab the user just chose.
  // jsdom has no scrollIntoView, hence the optional call.
  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeSpaceId])

  const focusTab = (index: number): void => {
    const tabs = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    const target = tabs?.[index]
    if (target === undefined) return
    target.focus()
    const space = spaces[index]
    if (space !== undefined) onSelect(space.id)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // F2 is the platform's rename key; it opens the active tab for editing.
    if (event.key === 'F2') {
      event.preventDefault()
      setEditingId(activeSpaceId)
      return
    }
    const tabs = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
    const current = Math.max(
      0,
      tabs.findIndex(
        (tab) => tab === document.activeElement || tab.contains(document.activeElement),
      ),
    )
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % spaces.length
        break
      case 'ArrowLeft':
        next = (current - 1 + spaces.length) % spaces.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = spaces.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    focusTab(next)
  }

  const endDrag = (): void => {
    setDraggingId(null)
    setDropBeforeId(undefined)
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    const draggedId = event.dataTransfer.getData(SPACE_MIME)
    const beforeId = dropBeforeId
    endDrag()
    if (draggedId === '' || beforeId === undefined || onReorder === undefined) return
    event.preventDefault()
    onReorder(draggedId, beforeId)
  }

  const animation = reducedMotion ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT_EXPO }

  /**
   * The right-click entries for one tab. Rename is the item the user asked for;
   * the rest are the tab moves that have nowhere else to live.
   */
  const itemsFor = (space: Space): ContextMenuItem[] => {
    const index = spaces.findIndex((entry) => entry.id === space.id)
    const items: ContextMenuItem[] = [
      {
        id: 'rename',
        label: 'Rename…',
        icon: Pencil,
        onSelect: () => setEditingId(space.id),
      },
      {
        id: 'new',
        label: 'New space',
        icon: Plus,
        disabled: !canCreate,
        disabledReason: `Ari holds at most ${String(MAX_SPACES)} spaces`,
        onSelect: onCreate,
      },
      {
        id: 'move-left',
        label: 'Move left',
        icon: ChevronLeft,
        disabled: onReorder === undefined || index <= 0,
        onSelect: () => onReorder?.(space.id, spaces[index - 1]?.id ?? null),
      },
      {
        id: 'move-right',
        label: 'Move right',
        icon: ChevronRight,
        disabled: onReorder === undefined || index >= spaces.length - 1,
        onSelect: () => onReorder?.(space.id, spaces[index + 2]?.id ?? null),
      },
    ]
    if (spaces.length > 1) {
      items.push({
        id: 'close',
        label: 'Close space',
        icon: X,
        danger: true,
        onSelect: () => onClose(space.id),
      })
    }
    return items
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border/50 bg-surface-0">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Spaces"
        onKeyDown={onListKeyDown}
        onDragOver={(event) => {
          if (draggingId !== null) event.preventDefault()
        }}
        onDrop={onDrop}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {spaces.map((space, index) => {
          const selected = space.id === activeSpaceId
          const editing = editingId === space.id
          const status = statusOf?.(space) ?? null
          return (
            <motion.div
              key={space.id}
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={animation}
              className="relative flex h-7 shrink-0 items-center"
            >
              <div
                role="tab"
                id={`space-tab-${space.id}`}
                aria-selected={selected}
                aria-controls="space-panel"
                aria-label={space.name}
                tabIndex={selected ? 0 : -1}
                title={status === null ? space.name : `${space.name} — ${STATUS_LABEL[status]}`}
                draggable={!editing}
                onContextMenu={(event) => menu.open(space.id, event)}
                onClick={() => {
                  if (!editing) onSelect(space.id)
                }}
                onDoubleClick={() => setEditingId(space.id)}
                onDragStart={(event) => {
                  event.dataTransfer.setData(SPACE_MIME, space.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDraggingId(space.id)
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  if (draggingId === null || draggingId === space.id) return
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const before = event.clientX < rect.left + rect.width / 2
                  setDropBeforeId(before ? space.id : (spaces[index + 1]?.id ?? null))
                }}
                className={`group relative isolate flex h-7 max-w-44 min-w-24 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors ${
                  selected ? 'text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                } focus-visible:ring-2 focus-visible:ring-accent-ring ${
                  draggingId === space.id ? 'opacity-40' : ''
                }`}
              >
                {selected ? (
                  <motion.span
                    layoutId="space-tab-active"
                    aria-hidden
                    transition={animation}
                    className="absolute inset-0 -z-10 rounded-md border border-border bg-surface-2"
                  />
                ) : null}

                {status !== null ? (
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${STATUS_CLASS[status]}`}
                  />
                ) : (
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${selected ? 'bg-fg-subtle' : 'bg-fg-subtle/40'}`}
                  />
                )}

                {editing ? (
                  <input
                    autoFocus
                    defaultValue={space.name}
                    aria-label="Rename space"
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) => {
                      onRename(space.id, event.currentTarget.value)
                      setEditingId(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onRename(space.id, event.currentTarget.value)
                        setEditingId(null)
                      } else if (event.key === 'Escape') {
                        setEditingId(null)
                      }
                    }}
                    className="min-w-0 flex-1 rounded-sm border border-accent/40 bg-surface-1 px-1 py-0.5 text-xs text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{space.name}</span>
                )}

                {spaces.length > 1 && !editing ? (
                  <button
                    type="button"
                    aria-label={`Close ${space.name}`}
                    title={`Close ${space.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onClose(space.id)
                    }}
                    className={`-mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                      selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <X size={11} aria-hidden />
                  </button>
                ) : null}
              </div>

              {dropBeforeId === space.id && draggingId !== null ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent"
                />
              ) : null}
            </motion.div>
          )
        })}

        {/* Drop target for "move to the end": empty space after the last tab. */}
        {draggingId !== null && onReorder !== undefined ? (
          <div
            aria-hidden
            onDragOver={(event) => {
              event.preventDefault()
              setDropBeforeId(null)
            }}
            onDrop={onDrop}
            className="h-7 min-w-6 flex-1 self-center"
          />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center border-l border-border/50 px-1.5">
        <button
          type="button"
          aria-label="New space"
          title="New space (Ctrl+Alt+T)"
          disabled={!canCreate}
          onClick={onCreate}
          className="flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>

      {menuSpace !== null ? (
        <ContextMenu
          anchor={menu.anchor}
          label={`${menuSpace.name} space`}
          items={itemsFor(menuSpace)}
          onClose={menu.close}
        />
      ) : null}
    </div>
  )
}

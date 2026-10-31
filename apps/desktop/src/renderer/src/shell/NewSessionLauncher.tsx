import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Folder, FolderPlus, Search } from 'lucide-react'
import { menuInVariants } from '@ari/ui/motion'
import { layerRoot } from '@ari/ui/layer-root'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import type { Project } from '@ari/contracts/project'
import type { SessionSummary } from '@ari/contracts/rpc'

/**
 * Compact relative age for "last opened" labels — member of the same family
 * as the sidebar's `formatRelativeTime`, worded for a chooser: "2h ago",
 * and a plain date once "ago" stops reading naturally.
 */
function openedLabel(timestamp: number, now = Date.now()): string | null {
  if (timestamp <= 0) return null
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

const ITEM_HEIGHT = 44
/** The list scrolls past this; the search field stays what carries scale. */
const LIST_MAX_HEIGHT = 320

/**
 * The "New session" launcher: a centered, dimmed project chooser (same modal
 * pattern as the command palette) opened by the sidebar's New session button
 * and Mod+N. One row per project — the lead alternative is a per-row
 * `Alt+Enter` / chip, not a duplicated row — picked with the arrow keys or
 * the mouse, closed by Escape or a click on the scrim. The project the user
 * is currently working in ranks first.
 */
export function NewSessionLauncher({
  open,
  projects,
  sessions,
  preferredProjectId = null,
  onCreate,
  onAddProject,
  onClose,
}: {
  /** Whether the overlay is currently shown. */
  open: boolean
  projects: Project[]
  /** The live session list, for per-project open counts and recency. */
  sessions: SessionSummary[]
  /** The project of the focused session, offered first when set. */
  preferredProjectId?: string | null
  onCreate: (projectId: string, lead: boolean) => void
  onAddProject: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const overlayRef = useOverlayRef()

  /** The chosen project first, then newest-opened, then never-opened. */
  const ranked = useMemo(() => {
    const preferred = projects.filter((project) => project.id === preferredProjectId)
    const rest = [...projects]
      .filter((project) => project.id !== preferredProjectId)
      .sort(
        (a, b) =>
          b.lastOpenedAt - a.lastOpenedAt ||
          b.createdAt - a.createdAt ||
          a.name.localeCompare(b.name),
      )
    return [...preferred, ...rest]
  }, [projects, preferredProjectId])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return ranked
    return ranked.filter(
      (project) =>
        project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q),
    )
  }, [query, ranked])

  // Opening resets to the head; a changed result list does the same.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  useLayoutEffect(() => {
    setActiveIndex((index) => (index < visible.length ? index : 0))
  }, [visible])

  // A new query is a new list. Clamping a stale index would highlight a
  // later match and Enter would open the wrong project.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Keep the highlighted row visible inside the capped, scrolling list.
  useLayoutEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const latest = useRef({ visible, activeIndex, onCreate, onClose })
  latest.current = { visible, activeIndex, onCreate, onClose }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      const state = latest.current
      switch (event.key) {
        case 'Escape': {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          break
        }
        case 'ArrowDown': {
          if (state.visible.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index + 1) % state.visible.length)
          break
        }
        case 'ArrowUp': {
          if (state.visible.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index - 1 + state.visible.length) % state.visible.length)
          break
        }
        case 'Enter': {
          // Buttons in the dialog (Lead, Add project, Pick a folder) must
          // receive Enter themselves. The capture listener only owns Enter
          // while the search field is focused.
          if (event.target !== inputRef.current) return
          event.preventDefault()
          event.stopPropagation()
          const project = state.visible[state.activeIndex]
          if (project) {
            const lead = event.altKey
            onClose()
            onCreate(project.id, lead)
          }
          break
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose, onCreate])

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div
          key="new-session-launcher"
          ref={overlayRef}
          onClick={onClose}
          className="fixed inset-0 z-overlay flex justify-center"
          style={{ background: 'color-mix(in oklab, black 45%, transparent)' }}
        >
          <motion.div
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={menuInVariants}
            role="dialog"
            aria-modal="true"
            aria-label="New session"
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
            className="mt-[12vh] h-fit w-[min(440px,90vw)] overflow-hidden rounded-lg border border-border bg-surface-2"
            style={{ boxShadow: 'var(--ari-shadow-3)' }}
          >
            <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
              <Search size={15} aria-hidden className="shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                type="text"
                aria-label="Search projects"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Jump to a project…"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
              <kbd className="shrink-0 rounded border border-border px-1.5 font-mono text-2xs text-fg-subtle/70">
                esc
              </kbd>
            </div>

            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
                <p className="text-sm text-fg-subtle">
                  {query === '' ? 'No projects yet.' : `No project matches “${query.trim()}”`}
                </p>
                <button
                  type="button"
                  onClick={onAddProject}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  <FolderPlus size={13} aria-hidden />
                  {query === '' ? 'Pick a folder…' : 'Pick a folder anyway'}
                </button>
              </div>
            ) : (
              <div
                ref={listRef}
                role="listbox"
                aria-label="Projects"
                className="ari-scroll overflow-y-auto p-1"
                style={{ maxHeight: LIST_MAX_HEIGHT }}
              >
                {visible.map((project, index) => {
                  const openCount = sessions.filter(
                    (session) => session.projectId === project.id && !session.archived,
                  ).length
                  const meta =
                    openCount > 0 ? `${openCount} open` : (openedLabel(project.lastOpenedAt) ?? '')
                  const missing = project.status === 'missing'
                  return (
                    <div
                      key={project.id}
                      role="option"
                      aria-selected={index === activeIndex}
                      aria-label={project.name}
                      title={project.path}
                      onMouseMove={(event) => {
                        // scrollIntoView of the highlighted row fires a move
                        // with no pointer travel and would pull selection back.
                        if (event.movementX === 0 && event.movementY === 0) return
                        setActiveIndex(index)
                      }}
                      onClick={(event) => {
                        const lead = event.altKey
                        onClose()
                        onCreate(project.id, lead)
                      }}
                      className={`group flex cursor-default select-none items-center gap-3 rounded-md border border-transparent px-2.5 transition-colors ${
                        index === activeIndex ? 'border-border bg-surface-3/60' : ''
                      }`}
                      style={{ height: ITEM_HEIGHT }}
                    >
                      <Folder
                        size={14}
                        aria-hidden
                        className={`shrink-0 ${missing ? 'text-fg-subtle/70' : 'text-fg-muted'}`}
                      />
                      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                        <span
                          className={`truncate text-sm font-medium ${missing ? 'text-fg-subtle' : 'text-fg'}`}
                        >
                          {project.name}
                          {missing ? ' (folder missing)' : ''}
                        </span>
                        {/* Reversed text with left ellipsis keeps the tail —
                            the distinguishing part of a path — visible. */}
                        <span className="truncate text-left font-mono text-2xs text-fg-subtle/70 [direction:rtl]">
                          {project.path}
                        </span>
                      </span>
                      <span className="shrink-0 text-2xs text-fg-subtle/70">
                        {project.id === preferredProjectId ? 'current' : meta}
                      </span>
                      <button
                        type="button"
                        aria-label={`Lead session in ${project.name}`}
                        title="Lead session (Alt+Enter)"
                        onClick={(event) => {
                          event.stopPropagation()
                          onClose()
                          onCreate(project.id, true)
                        }}
                        className="shrink-0 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-2xs font-medium text-accent opacity-0 transition-opacity hover:border-accent-ring focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring group-hover:opacity-100 group-aria-selected:opacity-100"
                      >
                        Lead ↵
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-border px-4 text-2xs text-fg-subtle/70">
              <span className="flex h-10 items-center truncate">
                <kbd className="rounded border border-border px-1 font-mono">↑↓</kbd> pick{' '}
                <kbd className="ml-1.5 rounded border border-border px-1 font-mono">↵</kbd> open{' '}
                <kbd className="ml-1.5 rounded border border-border px-1 font-mono">alt ↵</kbd> lead
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={onAddProject}
                className="-mr-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <FolderPlus size={12} aria-hidden />
                Add project…
              </button>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    layerRoot(),
  )
}

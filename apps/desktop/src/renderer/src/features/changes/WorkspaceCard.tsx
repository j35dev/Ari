import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FolderGit2, FolderOpen, GitBranch } from 'lucide-react'
import { LAYER_ROOT_ID } from '@ari/ui/layer-root'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { branchLabel } from '../session/branch-label'
import { GitControl } from './GitControl'
import { useSourceControl } from './use-source-control'

const log = createLogger('ui:workspace-card')

function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}

/**
 * The workspace at a glance, inside each chat pane: a pill in the pane's top
 * right corner (branch and change count) that drops down a card with the
 * folder, the branch, the next Git step and the line totals. Every pane has
 * its own, so a split shows each session's workspace where its chat is.
 */
export function WorkspaceCard({
  sessionId,
  active = true,
  onReview,
  onPullRequests,
}: {
  sessionId: string
  /** False while the pane is kept alive off screen; it then reads nothing. */
  active?: boolean
  onReview?: () => void
  onPullRequests?: () => void
}) {
  const scope = useMemo(() => ({ sessionId }), [sessionId])
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { summary, refresh } = useSourceControl(active ? scope : null, 'summary')
  // Line totals cost a diff read, so they are only fetched while the card is open.
  const review = useSourceControl(open && active && summary !== null ? scope : null, {
    kind: 'working-tree',
  })
  const totals = useMemo(() => {
    const files = review.manifest?.files
    if (files === undefined) return null
    return files.reduce(
      (sum, file) => ({
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    )
  }, [review.manifest])

  useEffect(() => {
    if (!active) return
    let live = true
    void rpc
      .invoke('session.workspace', { sessionId })
      .then((result) => {
        if (live) setPath(result?.path ?? null)
      })
      .catch((error: unknown) => log.warn('workspace lookup failed', { error: String(error) }))
    return () => {
      live = false
    }
  }, [sessionId, active])

  // Closes on a click elsewhere or Escape, like any drop-down. Clicks inside
  // floating menus the card opened (the Git menu, dialogs) are not "elsewhere".
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null || rootRef.current?.contains(target)) return
      if (
        target instanceof Element &&
        target.closest(`#${LAYER_ROOT_ID}, [role="dialog"], [role="menu"]`)
      )
        return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Outside a repository and with no folder known yet, there is nothing to show.
  if (summary === null && path === null) return null

  const reveal = (): void => {
    if (path === null) return
    void rpc
      .invoke('shell.revealPath', { path })
      .catch((error: unknown) => log.warn('reveal failed', { error: String(error) }))
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute right-4 top-2 z-pane-chrome flex flex-col items-end"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Workspace"
        aria-expanded={open}
        title={path ?? undefined}
        className={`pointer-events-auto flex h-7 max-w-56 items-center gap-1.5 rounded-full border px-2.5 text-xs shadow-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          open
            ? 'border-border-strong bg-surface-2 text-fg'
            : 'border-border bg-surface-1 text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        {summary !== null ? (
          <>
            <GitBranch size={12} aria-hidden className="shrink-0" />
            <span className="truncate">
              {summary.branch ? branchLabel(summary.branch) : 'detached'}
            </span>
            {summary.changedFiles > 0 ? (
              <span className="shrink-0 tabular-nums text-fg-subtle">· {summary.changedFiles}</span>
            ) : null}
          </>
        ) : (
          <>
            <FolderGit2 size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{path === null ? '' : folderName(path)}</span>
          </>
        )}
        <ChevronDown
          size={12}
          aria-hidden
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <section
          aria-label="Workspace summary"
          className="ari-enter-rise pointer-events-auto mt-1.5 w-64 rounded-2xl border border-border bg-surface-1 p-1.5 shadow-3"
        >
          <div className="flex items-center gap-1 pb-1">
            <div
              className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1"
              title={path ?? undefined}
            >
              <FolderGit2 size={14} aria-hidden className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                {path === null ? 'Workspace' : folderName(path)}
              </span>
            </div>
            {path !== null ? (
              <button
                type="button"
                onClick={reveal}
                aria-label="Open in File Explorer"
                title="Open in File Explorer"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-2/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <FolderOpen size={14} aria-hidden />
              </button>
            ) : null}
          </div>
          {summary !== null ? (
            <div className="border-t border-border/70 pt-1">
              <GitControl
                variant="card"
                scope={scope}
                summary={summary}
                refresh={() => {
                  refresh()
                  review.refresh()
                }}
                totals={totals}
                onReview={() => {
                  setOpen(false)
                  onReview?.()
                }}
                onPullRequests={() => {
                  setOpen(false)
                  onPullRequests?.()
                }}
              />
            </div>
          ) : (
            <p className="border-t border-border/70 px-2 pb-1 pt-2 text-xs text-fg-subtle">
              Not a Git repository.
            </p>
          )}
        </section>
      ) : null}
    </div>
  )
}

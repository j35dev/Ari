import { useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('session:branch')

/** How often the readout re-checks the branch while mounted. */
export const BRANCH_POLL_MS = 10_000

/**
 * Contextual branch readout inside the session space: shows the active
 * session's git branch in a slim reserved strip at the top of the transcript.
 * Asks git.status with the session scope — the worktree resolves server-side —
 * on mount and on a poll, so a branch change behind the open session refreshes
 * instead of going stale until remount. The strip mounts only when a branch
 * exists and reserves its own row, so the pill never overlays scrolling
 * checkpoints; outside repos it stays hidden.
 */
export function SessionBranchChip({ sessionId }: { sessionId: string | null }) {
  const [branch, setBranch] = useState<string | null>(null)
  const missesRef = useRef(0)

  useEffect(() => {
    setBranch(null)
    missesRef.current = 0
    if (sessionId === null) return
    let cancelled = false
    const refresh = (): void => {
      void rpc
        .invoke('git.status', { sessionId })
        .then((status) => {
          if (cancelled) return
          if (status.isRepo && status.branch) {
            missesRef.current = 0
            setBranch(status.branch)
            return
          }
          // git.status reports every git failure as non-repo, so a single
          // miss means nothing — only consecutive misses clear the readout,
          // which hides a removed repo without blanking on transient blips.
          // Rejected RPCs keep the last known branch unconditionally.
          missesRef.current += 1
          if (missesRef.current >= 3) setBranch(null)
        })
        .catch((error: unknown) => log.warn('rpc call failed', error))
    }
    refresh()
    const timer = setInterval(refresh, BRANCH_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  if (branch === null) return null
  return (
    <div className="flex h-7 shrink-0 items-center justify-end gap-2 px-3">
      <span
        className="flex h-6 items-center gap-1.5 rounded-full border border-border/80 bg-surface-1/90 px-2.5 font-mono text-2xs text-fg-muted shadow-sm transition-colors hover:border-border-strong hover:text-fg"
        title="Active branch"
      >
        <GitBranch size={11} className="text-accent" aria-hidden="true" />
        <span className="max-w-40 truncate font-semibold">{branch}</span>
      </span>
    </div>
  )
}

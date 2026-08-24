import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, FileText, GitBranch, GitPullRequest } from 'lucide-react'
import { DiffViewer } from '../diffs'
import { rpc } from '../../lib/rpc'
import { CheckpointList } from './CheckpointList'

interface StatusState {
  isRepo: boolean
  branch: string | null
  files: { path: string; staged: boolean; kind: string }[]
  error?: string
}

type ShipPhase = 'commit' | 'pr' | 'done'

export interface ChangesViewProps {
  /** Active session whose per-turn checkpoints are listed below the diff. */
  sessionId?: string | null
  /** The active session's project id; pairs with {@link sessionId}. */
  projectId?: string | null
}

/**
 * Changes rail view: worktree status for the first registered project plus
 * the full unified diff vs HEAD rendered by the shared diff viewer. When a
 * session is active its turn checkpoints (list + revert) mount underneath.
 */
export function ChangesView({ sessionId = null, projectId = null }: ChangesViewProps) {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusState | null>(null)
  const [diffText, setDiffText] = useState<string>('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void rpc
      .invoke('project.list')
      .then((projects) => {
        setProjectPath(projects[0]?.path ?? null)
      })
      .catch(() => undefined)
  }, [])

  const refresh = useCallback(() => {
    if (!projectPath) return
    setLoading(true)
    void rpc
      .invoke('git.status', { path: projectPath })
      .then(setStatus)
      .catch(() => setStatus({ isRepo: false, branch: null, files: [], error: 'unreachable' }))
      .finally(() => setLoading(false))
    void rpc
      .invoke('git.diffWorktree', { path: projectPath })
      .then((r) => setDiffText(r.diffText))
      .catch(() => undefined)
  }, [projectPath])

  useEffect(refresh, [refresh])

  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-subtle">
        Add a project first — Changes tracks its git worktree.
      </div>
    )
  }

  return (
    <div className="ari-scroll h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-semibold text-fg">Changes</span>
          {status?.branch ? (
            <span className="flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
              <GitBranch size={10} /> {status.branch}
            </span>
          ) : null}
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Refresh"
            onClick={refresh}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {!status?.isRepo ? (
          <p className="text-sm text-fg-subtle">
            {status?.error ?? 'This folder is not a git repository.'}
          </p>
        ) : status.files.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-fg-subtle">
            <FileText size={14} /> Worktree clean — nothing to review.
          </p>
        ) : (
          <>
            <ul className="mb-4 flex flex-wrap gap-1.5">
              {status.files.map((f) => (
                <li
                  key={`${f.path}:${String(f.staged)}`}
                  className="rounded-sm border border-border bg-surface-1 px-1.5 py-0.5 font-mono text-2xs text-fg-muted"
                >
                  {f.staged ? '• ' : ''}
                  {f.path}
                </li>
              ))}
            </ul>
            {diffText.length > 0 ? <DiffViewer diffText={diffText} /> : null}
          </>
        )}

        {sessionId ? (
          <div className="mt-8 border-t border-border pt-6">
            <CheckpointList projectId={projectId ?? 'adhoc'} sessionId={sessionId} />
          </div>
        ) : null}

        {status?.isRepo ? (
          <div className="mt-8 border-t border-border pt-6">
            <ShipSection projectPath={projectPath} hasChanges={status.files.length > 0} onShipped={refresh} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Ship flow (M21.4, Conductor's arc): stage-all → commit → push in one
 * action, then an inline PR form driven by `gh pr create`. Each step reports
 * its failure inline; the PR link lands as plain text.
 */
export function ShipSection({
  projectPath,
  hasChanges,
  onShipped,
}: {
  projectPath: string
  hasChanges: boolean
  onShipped: () => void
}) {
  const [message, setMessage] = useState('')
  const [phase, setPhase] = useState<ShipPhase>('commit')
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commitAndPush = (): void => {
    const trimmed = message.trim()
    if (trimmed.length === 0 || busy) return
    setBusy(true)
    setError(null)
    void rpc
      .invoke('git.add', { path: projectPath, paths: ['.'] })
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        return rpc.invoke('git.commit', { path: projectPath, message: trimmed })
      })
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        return rpc.invoke('git.push', { path: projectPath }).then((p) => {
          if (!p.ok) throw new Error(p.error)
        })
      })
      .then(() => {
        setPhase('pr')
        setPrTitle(trimmed.split('\n')[0] ?? trimmed)
        setMessage('')
        onShipped()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const createPr = (): void => {
    if (busy || prTitle.trim().length === 0) return
    setBusy(true)
    setError(null)
    void rpc
      .invoke('git.createPr', {
        path: projectPath,
        title: prTitle.trim(),
        ...(prBody.trim().length > 0 ? { body: prBody.trim() } : {}),
      })
      .then((r) => {
        if (!r.ok) throw new Error(r.error ?? 'PR creation failed')
        setPrUrl(r.url)
        setPhase('done')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section aria-label="Ship" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
        <GitPullRequest size={13} className="text-fg-subtle" /> Ship
      </h3>

      {phase === 'commit' ? (
        <div className="flex items-center gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAndPush()
            }}
            disabled={busy || !hasChanges}
            placeholder={hasChanges ? 'Commit message — stages all changes' : 'Worktree clean'}
            aria-label="Commit message"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-glass-input px-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          <button
            type="button"
            onClick={commitAndPush}
            disabled={busy || !hasChanges || message.trim().length === 0}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-fg-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {busy ? 'Shipping…' : 'Commit & push'}
          </button>
        </div>
      ) : null}

      {phase === 'pr' ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-2.5">
          <input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            aria-label="Pull request title"
            placeholder="PR title"
            className="h-7 w-full rounded-md border border-border bg-glass-input px-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            aria-label="Pull request description"
            placeholder="Description (optional)"
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-glass-input px-2 py-1 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={createPr}
              disabled={busy || prTitle.trim().length === 0}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-fg-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {busy ? 'Creating…' : 'Open pull request'}
            </button>
            <button
              type="button"
              onClick={() => setPhase('commit')}
              className="rounded-md px-2 py-1 text-xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              Skip
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'done' ? (
        <p className="text-xs text-success">
          Pull request open{prUrl !== null ? ' — ' : ''}
          {prUrl !== null ? (
            <span className="font-mono break-all">{prUrl}</span>
          ) : (
            ' (gh printed no URL)'
          )}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="break-words text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  )
}

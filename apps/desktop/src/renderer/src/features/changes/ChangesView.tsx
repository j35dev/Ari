import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, FileText, GitBranch } from 'lucide-react'
import { DiffViewer } from '../diffs'
import { rpc } from '../../lib/rpc'

interface StatusState {
  isRepo: boolean
  branch: string | null
  files: { path: string; staged: boolean; kind: string }[]
  error?: string
}

/**
 * Changes rail view: worktree status for the first registered project plus
 * the full unified diff vs HEAD rendered by the shared diff viewer.
 */
export function ChangesView() {
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
      </div>
    </div>
  )
}

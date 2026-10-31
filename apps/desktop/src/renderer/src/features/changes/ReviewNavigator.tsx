import { useState } from 'react'
import { History, Search } from 'lucide-react'
import type { GitHistoryEntry, GitReviewFile } from '@ari/contracts/rpc'
import { ChangedFiles } from './ChangedFiles'

/** Bounded file/history navigation shared by local and session review workspaces. */
export function ReviewNavigator({
  files,
  selected,
  filter,
  commits,
  onFilter,
  onSelect,
  onCommit,
  selectedPaths,
}: {
  files: GitReviewFile[]
  selected: string | undefined
  filter: string
  commits: GitHistoryEntry[]
  onFilter: (filter: string) => void
  onSelect: (path: string, multiple?: boolean) => void
  onCommit: (oid: string) => void
  selectedPaths?: ReadonlySet<string>
}) {
  const [history, setHistory] = useState(false)
  return (
    <aside className="flex w-56 min-w-40 max-w-[35%] shrink-0 flex-col border-r border-border/60 bg-surface-0">
      <div className="m-3 flex items-center gap-1">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/60 bg-bg px-2">
          <Search size={12} className="text-fg-subtle" />
          <input
            aria-label="Filter changed files"
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            maxLength={256}
            placeholder="Find a file…"
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
          />
        </label>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          aria-label="Show commit history"
          aria-pressed={history}
          onClick={() => setHistory(!history)}
        >
          <History size={14} />
        </button>
      </div>
      <div className="flex items-center justify-between px-3 pb-2 text-2xs text-fg-subtle">
        <span>{files.length} changed files</span>
        <span className="font-mono">
          +{files.reduce((sum, file) => sum + file.additions, 0)} −
          {files.reduce((sum, file) => sum + file.deletions, 0)}
        </span>
      </div>
      <ChangedFiles
        files={files}
        selected={selected}
        onSelect={onSelect}
        selectedPaths={selectedPaths}
      />
      {history ? (
        <div
          className="ari-scroll max-h-64 overflow-auto border-t border-border/60 p-2"
          aria-label="Recent commits"
        >
          {commits.length ? (
            commits.map((commit) => (
              <button
                key={commit.oid}
                type="button"
                onClick={() => onCommit(commit.oid)}
                className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
              >
                <span className="block truncate text-2xs text-fg-muted">{commit.subject}</span>
                <span className="font-mono text-2xs text-fg-subtle">
                  {commit.oid.slice(0, 7)} · {commit.author}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2 py-3 text-2xs text-fg-subtle">No commits yet.</p>
          )}
        </div>
      ) : null}
    </aside>
  )
}

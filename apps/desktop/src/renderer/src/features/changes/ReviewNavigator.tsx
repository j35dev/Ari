import { useState } from 'react'
import {
  CheckCheck,
  ChevronDown,
  FolderTree,
  GitCommitHorizontal,
  History,
  List,
  Search,
} from 'lucide-react'
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
  selectedCommit,
  onSelectAll,
}: {
  files: GitReviewFile[]
  selected: string | undefined
  filter: string
  commits: GitHistoryEntry[]
  onFilter: (filter: string) => void
  onSelect: (path: string, multiple?: boolean) => void
  onCommit: (oid: string) => void
  selectedPaths?: ReadonlySet<string>
  selectedCommit?: string
  onSelectAll?: () => void
}) {
  const [history, setHistory] = useState(false)
  const [tree, setTree] = useState(true)
  const [expanded, setExpanded] = useState(false)
  return (
    <aside className="flex max-h-[38%] w-full shrink-0 flex-col border-b border-border/60 bg-surface-0 @[44rem]:max-h-none @[44rem]:w-64 @[44rem]:min-w-44 @[44rem]:max-w-[30%] @[44rem]:border-b-0 @[44rem]:border-r">
      <button
        type="button"
        aria-label="Toggle changed file navigator"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring @[44rem]:hidden"
      >
        <FolderTree size={13} />
        <span>{files.length} changed files</span>
        <span className="ml-auto font-mono text-2xs">
          <span className="text-success">
            +{files.reduce((sum, file) => sum + file.additions, 0)}
          </span>{' '}
          <span className="text-danger">
            −{files.reduce((sum, file) => sum + file.deletions, 0)}
          </span>
        </span>
        <ChevronDown size={12} className={expanded ? 'rotate-180' : ''} />
      </button>
      <div className={`min-h-0 flex-1 flex-col ${expanded ? 'flex' : 'hidden'} @[44rem]:flex`}>
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
          {onSelectAll ? (
            <button
              type="button"
              aria-label="Select all files"
              title="Select all visible files"
              onClick={onSelectAll}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <CheckCheck size={13} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={tree ? 'Show file list' : 'Show file tree'}
            title={tree ? 'Switch to file list' : 'Switch to file tree'}
            onClick={() => setTree(!tree)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {tree ? <List size={14} /> : <FolderTree size={14} />}
          </button>
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
          tree={tree && !filter}
        />
        {history ? (
          <div
            className="ari-scroll max-h-[50%] overflow-auto border-t border-border/60 p-2"
            aria-label="Recent commits"
          >
            <p className="px-2 pb-2 pt-1 text-xs font-medium text-fg-muted">Recent commits</p>
            {commits.length ? (
              commits.map((commit) => (
                <button
                  key={commit.oid}
                  type="button"
                  onClick={() => onCommit(commit.oid)}
                  aria-current={selectedCommit === commit.oid ? 'true' : undefined}
                  className={`group relative mb-1 block w-full rounded-md py-2 pl-7 pr-2 text-left hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring ${selectedCommit === commit.oid ? 'bg-accent-subtle' : ''}`}
                >
                  <GitCommitHorizontal
                    size={13}
                    className="absolute left-2 top-2.5 text-fg-subtle"
                    aria-hidden
                  />
                  <span className="block truncate text-xs text-fg" title={commit.subject}>
                    {commit.subject}
                  </span>
                  <span className="font-mono text-2xs text-fg-subtle">
                    {commit.oid.slice(0, 7)} · {commit.author}
                  </span>
                  <time className="ml-2 text-2xs text-fg-subtle" dateTime={commit.at}>
                    {Number.isFinite(Date.parse(commit.at))
                      ? new Date(commit.at).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })
                      : ''}
                  </time>
                </button>
              ))
            ) : (
              <p className="px-2 py-3 text-2xs text-fg-subtle">No commits yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  )
}

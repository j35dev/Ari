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
import { cx, iconButton, iconButtonActive, sectionLabel } from '../../lib/recipes'
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
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <aside className="flex max-h-[38%] w-full shrink-0 flex-col border-b border-border @[44rem]:max-h-none @[44rem]:w-64 @[44rem]:min-w-44 @[44rem]:max-w-[30%] @[44rem]:border-b-0 @[44rem]:border-r">
      <button
        type="button"
        aria-label="Toggle changed file navigator"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex h-9 shrink-0 items-center gap-2 px-4 text-[13px] text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring @[44rem]:hidden"
      >
        <FolderTree size={14} className="shrink-0 text-fg-subtle" aria-hidden />
        <span>{files.length} changed files</span>
        <span className="ml-auto flex gap-2 font-mono text-xs tabular-nums">
          <span className="text-success">+{additions}</span>
          <span className="text-danger">−{deletions}</span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className={cx('shrink-0 text-fg-subtle', expanded && 'rotate-180')}
        />
      </button>
      <div className={`min-h-0 flex-1 flex-col ${expanded ? 'flex' : 'hidden'} @[44rem]:flex`}>
        <div className="mx-2 mt-2 flex items-center gap-0.5">
          <label className="mr-1 flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface-1 px-2 transition-colors hover:border-border-strong focus-within:border-border-strong focus-within:ring-2 focus-within:ring-accent-ring">
            <Search size={14} className="shrink-0 text-fg-subtle" aria-hidden />
            <input
              aria-label="Filter changed files"
              value={filter}
              onChange={(event) => onFilter(event.target.value)}
              maxLength={256}
              placeholder="Find a file…"
              className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
            />
          </label>
          {onSelectAll ? (
            <button
              type="button"
              aria-label="Select all files"
              title="Select all visible files"
              onClick={onSelectAll}
              className={iconButton}
            >
              <CheckCheck size={14} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={tree ? 'Show file list' : 'Show file tree'}
            title={tree ? 'Switch to file list' : 'Switch to file tree'}
            onClick={() => setTree(!tree)}
            className={iconButton}
          >
            {tree ? <List size={14} /> : <FolderTree size={14} />}
          </button>
          <button
            type="button"
            className={cx(iconButton, history && iconButtonActive)}
            aria-label="Show commit history"
            aria-pressed={history}
            onClick={() => setHistory(!history)}
          >
            <History size={14} />
          </button>
        </div>
        <div className={cx(sectionLabel, 'flex items-center justify-between px-4 pb-1 pt-4')}>
          <span>{files.length} changed files</span>
          <span className="flex gap-2 font-mono tabular-nums">
            <span className="text-success">+{additions}</span>
            <span className="text-danger">−{deletions}</span>
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
            className="ari-scroll max-h-[50%] overflow-auto border-t border-border px-2 pb-2"
            aria-label="Recent commits"
          >
            <p className={cx(sectionLabel, 'px-2 pb-1 pt-3')}>Recent commits</p>
            {commits.length ? (
              commits.map((commit) => (
                <button
                  key={commit.oid}
                  type="button"
                  onClick={() => onCommit(commit.oid)}
                  aria-current={selectedCommit === commit.oid ? 'true' : undefined}
                  className={cx(
                    'group relative block w-full rounded-md py-1.5 pl-8 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring',
                    selectedCommit === commit.oid ? 'bg-fg/9' : 'hover:bg-fg/5',
                  )}
                >
                  <GitCommitHorizontal
                    size={14}
                    className="absolute left-2 top-2 text-fg-subtle"
                    aria-hidden
                  />
                  <span className="block truncate text-[13px] text-fg" title={commit.subject}>
                    {commit.subject}
                  </span>
                  <span className="font-mono text-xs text-fg-subtle">
                    {commit.oid.slice(0, 7)} · {commit.author}
                  </span>
                  <time className="ml-2 text-xs text-fg-subtle" dateTime={commit.at}>
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
              <p className="px-2 py-2 text-xs text-fg-subtle">No commits yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  )
}

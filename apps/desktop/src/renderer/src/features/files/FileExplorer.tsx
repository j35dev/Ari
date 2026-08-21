import { useCallback, useEffect, useState } from 'react'
import type { RpcResults } from '@ari/contracts/rpc'
import { IconButton } from '@ari/ui/icon-button'
import { ChevronRight, FileText, Folder, FolderOpen, RotateCw } from 'lucide-react'
import { rpc } from '../../lib/rpc'

/** One listing row as returned by the `fs.list` RPC. */
type FsEntry = RpcResults['fs.list'][number]

/** Cached listings keyed by absolute directory path. */
type EntriesByDir = Record<string, FsEntry[]>

function joinPath(dir: string, name: string): string {
  const endsWithSep = dir.endsWith('/') || dir.endsWith('\\')
  if (endsWithSep) return `${dir}${name}`
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir}${sep}${name}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

interface ExplorerRowProps {
  entry: FsEntry
  path: string
  depth: number
  expanded: ReadonlySet<string>
  entries: EntriesByDir
  selected: string | null
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
}

function ExplorerRow({
  entry,
  path,
  depth,
  expanded,
  entries,
  selected,
  onToggleDir,
  onSelectFile,
}: ExplorerRowProps) {
  const isDir = entry.type === 'dir'
  const isExpanded = isDir && expanded.has(path)
  const children = isExpanded ? entries[path] : undefined
  const isSelected = !isDir && selected === path

  return (
    <li
      role="treeitem"
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={!isDir ? isSelected : undefined}
    >
      <button
        type="button"
        onClick={() => (isDir ? onToggleDir(path) : onSelectFile(path))}
        className={`flex w-full items-center gap-1 rounded-sm py-0.5 pr-2 text-left text-xs font-mono transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
          isSelected ? 'bg-surface-2 text-fg' : 'text-fg-muted'
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {isDir ? (
          <ChevronRight
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 text-fg-subtle transition-transform duration-150 ${
              isExpanded ? 'rotate-90' : ''
            }`}
          />
        ) : (
          <span aria-hidden="true" className="h-3 w-3 shrink-0" />
        )}
        {isDir ? (
          isExpanded ? (
            <FolderOpen aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-subtle" />
          ) : (
            <Folder aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-subtle" />
          )
        ) : (
          <FileText aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-subtle" />
        )}
        <span className="min-w-0 truncate">{entry.name}</span>
        {!isDir && (
          <span className="ml-auto shrink-0 tabular-nums text-fg-subtle">
            {formatSize(entry.size)}
          </span>
        )}
      </button>
      {isExpanded && (
        <ul role="group">
          {children == null ? (
            <li
              aria-hidden="true"
              className="py-0.5 font-mono text-xs text-fg-subtle"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              …
            </li>
          ) : (
            children.map((child) => (
              <ExplorerRow
                key={child.name}
                entry={child}
                path={joinPath(path, child.name)}
                depth={depth + 1}
                expanded={expanded}
                entries={entries}
                selected={selected}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
              />
            ))
          )}
        </ul>
      )}
    </li>
  )
}

/**
 * Lazy-loading workspace file tree for the inspector pane. Only the root is
 * listed on mount; directories are listed via the `fs.list` RPC the first
 * time they expand and cached until refresh.
 */
export function FileExplorer({ root }: { root: string }) {
  const [entries, setEntries] = useState<EntriesByDir>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries({})
    setExpanded(new Set())
    setSelected(null)
    setError(null)
    void rpc
      .invoke('fs.list', { path: root })
      .then((result) => {
        if (!cancelled) setEntries((prev) => ({ ...prev, [root]: result }))
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setEntries({})
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [root])

  /** Lists a directory and caches it; surfaces failures in `error`. */
  const listDir = useCallback((dir: string): void => {
    void rpc
      .invoke('fs.list', { path: dir })
      .then((result) => {
        setEntries((prev) => ({ ...prev, [dir]: result }))
        setError(null)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  const toggleDir = useCallback(
    (dir: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(dir)) next.delete(dir)
        else next.add(dir)
        return next
      })
      // Fetch only when the directory has not been listed yet; re-expanding a
      // collapsed one serves from cache until refresh.
      if (entries[dir] == null) listDir(dir)
    },
    [entries, listDir],
  )

  const refresh = useCallback((): void => {
    // Re-list every currently visible directory level: the root plus all
    // expanded dirs (collapsed-but-cached ones stay stale by design).
    listDir(root)
    for (const dir of expanded) listDir(dir)
  }, [expanded, listDir, root])

  const rootEntries = entries[root]

  return (
    <section aria-label="File explorer" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-border px-2 py-1">
        <h2 className="truncate font-mono text-xs text-fg-muted">{root}</h2>
        <IconButton
          size="sm"
          variant="ghost"
          icon={<RotateCw className="h-3.5 w-3.5" />}
          aria-label="Refresh file explorer"
          onClick={refresh}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error != null && (
          <p role="alert" className="px-1 py-1 font-mono text-xs text-danger">
            {error}
          </p>
        )}
        {rootEntries == null ? (
          error == null && (
            <p aria-hidden="true" className="px-1 py-1 font-mono text-xs text-fg-subtle">
              …
            </p>
          )
        ) : (
          <ul role="tree" aria-label="Workspace files">
            {rootEntries.map((entry) => (
              <ExplorerRow
                key={entry.name}
                entry={entry}
                path={joinPath(root, entry.name)}
                depth={0}
                expanded={expanded}
                entries={entries}
                selected={selected}
                onToggleDir={toggleDir}
                onSelectFile={setSelected}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, File, Folder } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GitReviewFile } from '@ari/contracts/rpc'
import { setDragFilePath } from '../composer/drag-file'
import { useSessionClient } from '../session/session-client'

/** Search-filtered, virtualized file navigator; paths remain literal mention/selection sources. */
export function ChangedFiles({
  files,
  selected,
  onSelect,
  selectedPaths,
  tree = false,
}: {
  files: GitReviewFile[]
  selected: string | undefined
  onSelect: (path: string, multiple?: boolean) => void
  selectedPaths?: ReadonlySet<string>
  tree?: boolean
}) {
  const client = useSessionClient()
  const scroll = useRef<HTMLElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rows = useMemo(() => {
    if (!tree) return files.map((file) => ({ file, folder: '', depth: 0 }))
    const result: { file?: GitReviewFile; folder: string; depth: number }[] = []
    const seen = new Set<string>()
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = file.path.split('/')
      let hidden = false
      for (let depth = 0; depth < parts.length - 1; depth++) {
        const folder = parts.slice(0, depth + 1).join('/')
        if (!seen.has(folder)) {
          result.push({ folder, depth })
          seen.add(folder)
        }
        if (collapsed.has(folder)) {
          hidden = true
          break
        }
      }
      if (!hidden) result.push({ file, folder: '', depth: parts.length - 1 })
    }
    return result
  }, [files, tree, collapsed])
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => (rows[index]?.file ? 34 : 28),
    overscan: 6,
  })
  return (
    <nav
      ref={scroll}
      aria-label="Changed files"
      className="ari-scroll min-h-0 flex-1 overflow-auto px-2 pb-2"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const current = files.findIndex((file) => file.path === selected)
        const next = Math.max(
          0,
          Math.min(files.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)),
        )
        if (files[next]) {
          onSelect(files[next].path)
          virtual.scrollToIndex(next, { align: 'auto' })
        }
      }}
    >
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const node = rows[item.index]!
          const file = node.file
          if (!file)
            return (
              <button
                key={`folder:${node.folder}`}
                type="button"
                aria-label={`Folder ${node.folder}`}
                aria-expanded={!collapsed.has(node.folder)}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(node.folder)) next.delete(node.folder)
                    else next.add(node.folder)
                    return next
                  })
                }
                className="absolute left-0 top-0 flex w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 8 + node.depth * 14,
                }}
              >
                {collapsed.has(node.folder) ? (
                  <ChevronRight size={14} className="shrink-0 text-fg-subtle" aria-hidden />
                ) : (
                  <ChevronDown size={14} className="shrink-0 text-fg-subtle" aria-hidden />
                )}
                <Folder size={14} className="shrink-0 text-fg-subtle" aria-hidden />
                <span className="truncate">{node.folder.split('/').at(-1)}</span>
              </button>
            )
          const at = file.path.lastIndexOf('/')
          return (
            <button
              key={file.path}
              type="button"
              aria-label={file.path}
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              aria-current={selected === file.path ? 'true' : undefined}
              aria-pressed={selectedPaths?.has(file.path)}
              draggable
              onDragStart={(event) => setDragFilePath(event, file.path, client.viewKey)}
              onClick={(event) => onSelect(file.path, event.ctrlKey || event.metaKey)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
                // In the tree a file sits under its folder's icon, past the chevron.
                paddingLeft: tree ? 28 + node.depth * 14 : 8,
              }}
              className={`flex items-center gap-2.5 rounded-md pr-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${selected === file.path ? 'bg-fg/9' : 'hover:bg-fg/5'}`}
            >
              <File size={14} className="shrink-0 text-fg-subtle" aria-hidden />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 truncate text-fg">{file.path.slice(at + 1)}</span>
                {at >= 0 && !tree ? (
                  <span className="min-w-0 truncate text-fg-subtle" dir="rtl">
                    {file.path.slice(0, at)}
                  </span>
                ) : null}
              </span>
              {selectedPaths?.has(file.path) ? (
                <Check size={12} className="shrink-0 text-fg-muted" aria-hidden />
              ) : null}
              {file.staged ? (
                <span className="size-1.5 shrink-0 rounded-full bg-fg-muted" title="Staged" />
              ) : null}
              <span title={file.kind} className="shrink-0 font-mono text-xs text-fg-subtle">
                {file.kind === 'untracked' ? '?' : file.kind[0]?.toUpperCase()}
              </span>
              {file.additions > 0 || file.deletions > 0 ? (
                <span className="flex shrink-0 gap-2 font-mono text-xs tabular-nums">
                  {file.additions > 0 ? (
                    <span className="text-success">+{file.additions}</span>
                  ) : null}
                  {file.deletions > 0 ? (
                    <span className="text-danger">−{file.deletions}</span>
                  ) : null}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

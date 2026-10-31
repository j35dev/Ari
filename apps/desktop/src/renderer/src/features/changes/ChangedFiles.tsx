import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GitReviewFile } from '@ari/contracts/rpc'
import { setDragFilePath } from '../composer/drag-file'

/** Search-filtered, virtualized file navigator; paths remain literal mention/selection sources. */
export function ChangedFiles({
  files,
  selected,
  onSelect,
}: {
  files: GitReviewFile[]
  selected: string | undefined
  onSelect: (path: string) => void
}) {
  const scroll = useRef<HTMLElement>(null)
  const virtual = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 44,
    overscan: 6,
  })
  return (
    <nav
      ref={scroll}
      aria-label="Changed files"
      className="ari-scroll min-h-0 flex-1 overflow-auto px-1.5 pb-2"
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
          const file = files[item.index]!
          const at = file.path.lastIndexOf('/')
          return (
            <button
              key={file.path}
              type="button"
              aria-label={file.path}
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              aria-current={selected === file.path ? 'true' : undefined}
              draggable
              onDragStart={(event) => setDragFilePath(event, file.path)}
              onClick={() => onSelect(file.path)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
              className={`flex items-center gap-2 rounded-md px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring ${selected === file.path ? 'bg-accent-subtle text-fg' : 'text-fg-muted hover:bg-surface-1'}`}
            >
              <span
                className={`font-mono text-2xs ${file.kind === 'deleted' ? 'text-danger' : file.kind === 'added' || file.kind === 'untracked' ? 'text-success' : 'text-fg-subtle'}`}
              >
                {file.kind === 'untracked' ? '?' : file.kind[0]?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-2xs">{file.path.slice(at + 1)}</span>
                {at >= 0 ? (
                  <span className="block truncate text-2xs text-fg-subtle">
                    {file.path.slice(0, at)}
                  </span>
                ) : null}
              </span>
              {file.staged ? (
                <span className="text-success" title="Staged">
                  •
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

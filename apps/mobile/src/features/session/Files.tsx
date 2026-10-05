import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FileCode, Folder, ArrowLeft, Copy, Check } from 'lucide-react'
import type { RemoteFile, RemoteFiles } from '@ari/contracts/remote'
import { useApp } from '../../lib/app-state'
import { EmptyState } from '../../components/EmptyState'

/** Browse the authorized session workspace, using desktop-enforced file boundaries. */
export function Files({ sessionId }: { sessionId: string }): ReactNode {
  const app = useApp()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<RemoteFiles | null>(null)
  const [file, setFile] = useState<RemoteFile | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const session = app.session
    if (session === null || !session.supports('files.list')) return
    let cancelled = false
    setLoading(true)
    setFailure(null)
    setListing(null)
    setFile(null)
    void (async () => {
      try {
        if (selected !== null) {
          const result = await session.query<RemoteFile>('files.read', {
            sessionId,
            path: selected,
          })
          if (!cancelled) {
            setFile(result)
            setFailure(result.error)
          }
        } else {
          const result = await session.query<RemoteFiles>('files.list', { sessionId, path })
          if (!cancelled) {
            setListing(result)
            setFailure(result.error)
          }
        }
      } catch (error) {
        if (!cancelled)
          setFailure(error instanceof Error ? error.message : 'Could not open this file.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [app.session, sessionId, path, selected, revision])
  if (!app.session?.supports('files.list'))
    return (
      <EmptyState
        title="Files need a desktop update"
        detail="Update Ari to browse this session's workspace from your phone."
      />
    )
  const parent = (): void => {
    if (selected !== null) {
      setSelected(null)
      setCopied(false)
    } else setPath(path.split('/').slice(0, -1).join('/'))
  }
  async function more(): Promise<void> {
    if (listing?.nextCursor === null || listing?.nextCursor === undefined || app.session === null)
      return
    setLoading(true)
    try {
      const result = await app.session.query<RemoteFiles>('files.list', {
        sessionId,
        path,
        cursor: listing.nextCursor,
      })
      setListing({ ...result, entries: [...listing.entries, ...result.entries] })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not load more files.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="min-w-0">
      <div className="mb-3 flex min-h-11 items-center gap-2 border-b border-border pb-2">
        {(path !== '' || selected !== null) && (
          <button type="button" className="icon-button" onClick={parent} aria-label="Parent folder">
            <ArrowLeft size={17} />
          </button>
        )}
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg-muted">
          {selected ?? (path || 'Workspace')}
        </span>
        {file?.content !== null && file?.content !== undefined && (
          <button
            type="button"
            aria-label="Copy file contents"
            className="icon-button"
            onClick={() => {
              void navigator.clipboard
                .writeText(file.content ?? '')
                .then(() => setCopied(true))
                .catch(() => setFailure('Clipboard access is unavailable.'))
            }}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
          </button>
        )}
      </div>
      {failure !== null && (
        <div role="alert" className="error-banner">
          <p>{failure}</p>
          <button
            type="button"
            className="min-h-11 font-medium"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="py-4 text-sm text-fg-muted">
          Reading workspace…
        </p>
      )}
      {selected === null && listing !== null && (
        <ul className="divide-y divide-border">
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() =>
                  entry.kind === 'directory' ? setPath(entry.path) : setSelected(entry.path)
                }
                className="flex min-h-12 w-full items-center gap-3 text-left"
              >
                {entry.kind === 'directory' ? (
                  <Folder size={17} className="text-fg-muted" />
                ) : (
                  <FileCode size={17} className="text-fg-subtle" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                <ChevronRight size={14} className="text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {listing?.nextCursor !== null && listing?.nextCursor !== undefined && selected === null && (
        <button
          type="button"
          className="secondary-button mt-3 w-full"
          disabled={loading}
          onClick={() => void more()}
        >
          Load more files
        </button>
      )}
      {file?.content !== null && file?.content !== undefined && (
        <div className="flex overflow-x-auto rounded-xl border border-border bg-surface-1 py-3 font-mono text-xs leading-6">
          <pre
            aria-hidden
            className="select-none border-r border-border px-3 text-right text-fg-subtle"
          >
            {file.content
              .split('\n')
              .map((_, index) => index + 1)
              .join('\n')}
          </pre>
          <pre className="px-3">{file.content}</pre>
        </div>
      )}
      {file !== null && file.error === null && file.kind !== 'text' && (
        <EmptyState
          title={file.kind === 'too-large' ? 'This file is too large to preview' : 'Binary file'}
          detail="Text previews are limited to 256 KB. Open this file on your computer."
        />
      )}
      {!loading && listing?.entries.length === 0 && (
        <p className="py-6 text-sm text-fg-muted">This folder has no files available to preview.</p>
      )}
      <p className="mt-5 text-[11px] leading-relaxed text-fg-subtle">
        Sensitive configuration, private keys, and symlinks are excluded. Files stay on your
        computer.
      </p>
    </div>
  )
}

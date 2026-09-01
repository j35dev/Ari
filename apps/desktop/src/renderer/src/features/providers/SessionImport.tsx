import { useCallback, useEffect, useState } from 'react'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:session-import')

type Importable = RpcResults['sessions.importable'][number]

export interface SessionImportProps {
  /** Refreshes the sidebar once a session lands in Ari's own store. */
  onImported?: (sessionId: string) => void
}

/**
 * Brings sessions the user already has in pi into Ari.
 *
 * The import replays pi's file into an Ari journal and never writes to pi's
 * store, so the same session stays resumable in pi afterwards — stated on the
 * surface, because "import" usually implies something is moved.
 */
export function SessionImport({ onImported }: SessionImportProps) {
  const [sessions, setSessions] = useState<Importable[]>([])
  const [loading, setLoading] = useState(true)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSessions(await rpc.invoke('sessions.importable', {}))
    } catch (e: unknown) {
      log.warn('could not list importable sessions', { error: String(e) })
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importOne = async (session: Importable): Promise<void> => {
    setError(null)
    setNotice(null)
    setBusyPath(session.path)
    try {
      const result = await rpc.invoke('sessions.import', { path: session.path })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setNotice(`Imported "${result.title}" — ${result.messageCount} entries.`)
      onImported?.(result.sessionId)
      await refresh()
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusyPath(null)
    }
  }

  return (
    <section aria-labelledby="agents-import-heading" className="space-y-3">
      <h2 id="agents-import-heading" className="text-sm font-medium">
        Import pi sessions
      </h2>
      <p className="text-sm text-fg-muted">
        Replays a session you already had in pi into Ari, with its transcript and usage. pi&apos;s own
        file is only read — the session stays resumable in pi.
      </p>

      {loading ? (
        <Spinner size="sm" />
      ) : sessions.length === 0 ? (
        <p className="text-sm text-fg-muted">No pi sessions found on this machine.</p>
      ) : (
        <ul className="flex flex-col">
          {sessions.map((session) => (
            <li
              key={session.path}
              className="flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-fg">{session.title}</span>
                  {session.imported ? <Badge tone="success">in Ari</Badge> : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-fg-muted">
                  {session.messageCount} messages · {formatWhen(session.updatedAt)} ·{' '}
                  <span className="font-mono">{session.cwd}</span>
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={session.imported || busyPath !== null}
                loading={busyPath === session.path}
                onClick={() => void importOne(session)}
                aria-label={`Import ${session.title}`}
              >
                {session.imported ? 'Imported' : 'Import'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice !== null ? <p className="text-sm text-fg-muted">{notice}</p> : null}
    </section>
  )
}

function formatWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'unknown date'
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

import { useCallback, useEffect, useState } from 'react'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:session-import')

type Importable = RpcResults['sessions.importable'][number]

export interface SessionImportListProps {
  /** When present, only Pi sessions whose cwd is this registered project are listed. */
  projectId?: string
  emptyMessage?: string
  onImported?: (sessionId: string) => void | Promise<void>
}

/**
 * Reusable Pi-session list shared by Settings and the project-scoped import
 * dialog. Import failures belong to their row, so one bad session never hides
 * or disables the rest of the available history.
 */
export function SessionImportList({
  projectId,
  emptyMessage = 'No pi sessions found on this machine.',
  onImported,
}: SessionImportListProps) {
  const [sessions, setSessions] = useState<Importable[]>([])
  const [loading, setLoading] = useState(true)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [errorsByPath, setErrorsByPath] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSessions(
        await rpc.invoke('sessions.importable', projectId === undefined ? {} : { projectId }),
      )
    } catch (e: unknown) {
      log.warn('could not list importable sessions', { error: String(e) })
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const busySession = sessions.find((session) => session.candidateId === busyPath) ?? null

  const importOne = async (session: Importable): Promise<void> => {
    setErrorsByPath((current) => {
      const next = { ...current }
      delete next[session.candidateId]
      return next
    })
    setNotice(null)
    setBusyPath(session.candidateId)
    try {
      const result = await rpc.invoke('sessions.import', {
        candidateId: session.candidateId,
        ...(projectId === undefined ? {} : { projectId }),
      })
      if (!result.ok) {
        setErrorsByPath((current) => ({ ...current, [session.candidateId]: result.error }))
        return
      }
      setNotice(`Imported "${result.title}" — ${result.messageCount} entries.`)
      if (onImported !== undefined) {
        await onImported(result.sessionId)
        return
      }
      await refresh()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      setErrorsByPath((current) => ({ ...current, [session.candidateId]: message }))
    } finally {
      setBusyPath(null)
    }
  }

  if (loading) {
  return (
        <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner size="sm" />
          <span>Finding pi sessions…</span>
        </div>
    )
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-fg-muted">{emptyMessage}</p>
  }

  return (
    <div className="space-y-3">
      <ul className="flex flex-col" aria-label="Pi sessions">
          {sessions.map((session) => {
          const error = errorsByPath[session.candidateId]
            return (
              <li
              key={session.candidateId}
                className="flex flex-col gap-1 border-b border-border/60 py-3 last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-fg">{session.title}</span>
                      {session.imported ? <Badge tone="success">in Ari</Badge> : null}
                      {error !== undefined ? <Badge tone="danger">error</Badge> : null}
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
                  loading={busyPath === session.candidateId}
                    onClick={() => void importOne(session)}
                    aria-label={
                    busyPath === session.candidateId
                        ? `Importing ${session.title}`
                        : error !== undefined
                          ? `Retry ${session.title}`
                          : `Import ${session.title}`
                    }
                  >
                    {session.imported
                      ? 'Imported'
                    : busyPath === session.candidateId
                        ? 'Importing…'
                        : error !== undefined
                          ? 'Retry'
                          : 'Import'}
                  </Button>
                </div>
                {error !== undefined ? (
                  <p role="alert" className="break-words text-xs text-danger">
                    {error}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>

      {busySession !== null ? (
        <p role="status" aria-live="polite" className="text-sm text-fg-muted">
          Importing “{busySession.title}”…
        </p>
      ) : null}
      {notice !== null ? <p className="text-sm text-fg-muted">{notice}</p> : null}
    </div>
  )
}

export interface SessionImportProps {
  /** Refreshes the sidebar once a session lands in Ari's own store. */
  onImported?: (sessionId: string) => void | Promise<void>
}

/** Settings surface for every Pi session found on this machine. */
export function SessionImport({ onImported }: SessionImportProps) {
  return (
    <section aria-labelledby="agents-import-heading" className="space-y-3">
      <h2 id="agents-import-heading" className="text-sm font-medium">
        Import pi sessions
      </h2>
      <p className="text-sm text-fg-muted">
        Replays a session you already had in pi into Ari, with its transcript and usage. pi&apos;s
        own file is only read — the session stays resumable in pi.
      </p>
      <SessionImportList onImported={onImported} />
    </section>
  )
}

function formatWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'unknown date'
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

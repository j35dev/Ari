import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteApproval, RemoteInput } from '@ari/contracts/remote'
import type { SessionSummary } from '@ari/contracts/rpc'
import { useApp } from '../../lib/app-state'
import { relativeTime, summarizeToolDetail } from '../../lib/format'

/**
 * Now: what needs a person, ordered by how much it needs one (ADR §13).
 *
 * Approvals and questions come first because an agent is blocked behind each
 * one; running work and recents follow, because they are things to look at
 * rather than things to unblock. Deliberately not a statistics dashboard.
 */

interface Waiting {
  session: SessionSummary
  approvals: RemoteApproval[]
  inputs: RemoteInput[]
}

export function NowScreen({ onOpen }: { onOpen: (sessionId: string) => void }): ReactNode {
  const app = useApp()
  const [waiting, setWaiting] = useState<Waiting[]>([])
  const [loading, setLoading] = useState(true)

  const active = app.sessions.filter((session) => session.archived !== true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const found: Waiting[] = []
      // Only the recently touched sessions are inspected: a phone that asked
      // about every session it has ever had would cost the desktop a journal
      // replay each time it was opened.
      for (const session of active.slice(0, 12)) {
        if (app.session === null || !app.session.supports('session.get')) break
        try {
          const snapshot = await app.session.query<{
            pendingApprovals: RemoteApproval[]
            pendingInputs: RemoteInput[]
          }>('session.get', { sessionId: session.id })
          if (snapshot !== null && (snapshot.pendingApprovals.length > 0 || snapshot.pendingInputs.length > 0)) {
            found.push({ session, approvals: snapshot.pendingApprovals, inputs: snapshot.pendingInputs })
          }
        } catch {
          // One unreadable session must not empty the whole screen: the rest
          // of the list is still true, and the user can open that one itself.
        }
      }
      if (!cancelled) {
        setWaiting(found)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Re-derived whenever the list or the connection changes.
  }, [app.session, app.sessions, app.connection])

  const running = active.filter((session) => session.status === 'running')
  const recent = active
    .filter((session) => session.status !== 'running')
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)

  return (
    <div className="h-full overflow-y-auto px-4 pb-6 pt-4">
      {app.error !== null && (
        <p role="alert" className="mb-4 rounded-md border border-danger bg-danger-subtle p-3 text-sm">
          {app.error}
        </p>
      )}

      <Section
        title="Waiting on you"
        hasItems={waiting.length > 0}
        empty={!loading ? 'Nothing is blocked.' : null}
      >
        {waiting.map((entry) => (
          <button
            key={entry.session.id}
            type="button"
            onClick={() => onOpen(entry.session.id)}
            className="block w-full rounded-md border border-warning bg-warning-subtle p-3 text-left"
          >
            <p className="text-sm font-medium">{entry.session.title || 'Untitled session'}</p>
            <p className="mt-1 text-xs text-fg-muted">
              {entry.approvals.length > 0 &&
                `${entry.approvals.length} approval${entry.approvals.length === 1 ? '' : 's'} waiting`}
              {entry.approvals.length > 0 && entry.inputs.length > 0 && ' · '}
              {entry.inputs.length > 0 &&
                `${entry.inputs.length} question${entry.inputs.length === 1 ? '' : 's'}`}
            </p>
            {entry.approvals[0] !== undefined && (
              <p className="mt-2 line-clamp-2 font-mono text-2xs text-fg-subtle">
                {entry.approvals[0].toolName}: {summarizeToolDetail(entry.approvals[0].summaryJson)}
              </p>
            )}
          </button>
        ))}
      </Section>

      <Section
        title="Running"
        hasItems={running.length > 0}
        empty={!loading ? 'No agent is working right now.' : null}
      >
        {running.map((session) => (
          <SessionRow key={session.id} session={session} onOpen={onOpen} />
        ))}
      </Section>

      <Section
        title="Recently finished"
        hasItems={recent.length > 0}
        empty={!loading ? 'No finished sessions yet.' : null}
      >
        {recent.map((session) => (
          <SessionRow key={session.id} session={session} onOpen={onOpen} />
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  empty,
  hasItems,
  children,
}: {
  title: string
  /** Shown in place of the list when it is empty; null while still loading. */
  empty: string | null
  /** Whether there is anything to render; the caller knows, not the element. */
  hasItems: boolean
  children: ReactNode
}): ReactNode {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{title}</h2>
      {hasItems ? <div className="space-y-2">{children}</div> : null}
      {!hasItems && empty !== null && <p className="text-sm text-fg-muted">{empty}</p>}
    </section>
  )
}

export function SessionRow({
  session,
  onOpen,
}: {
  session: SessionSummary
  onOpen: (sessionId: string) => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-1 p-3 text-left"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm">{session.title || 'Untitled session'}</span>
        <span className="mt-0.5 block text-2xs text-fg-subtle">
          {relativeTime(session.updatedAt)} · {session.messageCount} message
          {session.messageCount === 1 ? '' : 's'}
        </span>
      </span>
      <span className="shrink-0 text-2xs text-fg-muted">{session.status}</span>
    </button>
  )
}

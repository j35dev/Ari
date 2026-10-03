import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, CheckCheck, RefreshCw, ShieldCheck } from 'lucide-react'
import type { RemoteAttention } from '@ari/contracts/remote'
import { ScreenHeader } from '../../components/ui'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { relativeTime, summarizeToolDetail } from '../../lib/format'

/** Fetch every authorized page; a partial inbox must never claim nothing is blocked. */
export function NowScreen({ onOpen }: { onOpen: (id: string) => void }): ReactNode {
  const app = useApp()
  const [items, setItems] = useState<RemoteAttention['items']>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const session = app.session
    if (session === null || !session.usable) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setFailure(null)
    void (async () => {
      try {
        if (!session.supports('attention.list'))
          throw new Error(
            'Update Ari on your computer to see a complete inbox. You can still answer approvals inside each session.',
          )
        const collected: RemoteAttention['items'] = []
        let cursor: string | null = null
        const seen = new Set<string>()
        do {
          const page: RemoteAttention = await session.query<RemoteAttention>(
            'attention.list',
            cursor === null ? {} : { cursor },
          )
          if (cancelled) return
          collected.push(...page.items)
          cursor = page.nextCursor
          if (cursor !== null && seen.has(cursor))
            throw new Error('The desktop returned an incomplete inbox. Please refresh.')
          if (cursor !== null) seen.add(cursor)
        } while (cursor !== null)
        if (!cancelled) setItems(collected.sort((a, b) => b.updatedAt - a.updatedAt))
      } catch (error) {
        if (!cancelled)
          setFailure(error instanceof Error ? error.message : 'Could not check the inbox.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [app.session, app.sessions, app.connection, revision])
  const waiting = items.filter(
    (item) => item.pendingApprovals.length > 0 || item.pendingInputs.length > 0,
  )
  const failed = items.filter((item) => item.error !== null)
  return (
    <div className="h-full overflow-y-auto px-5 pb-6 pt-5">
      <ScreenHeader
        title="Inbox"
        subtitle="The moments that need your judgment."
        action={
          <button
            type="button"
            className="icon-button text-fg-muted"
            aria-label="Refresh inbox"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
          </button>
        }
      />
      {failure !== null && (
        <p role="alert" className="error-banner">
          {failure}
        </p>
      )}
      {loading && (
        <p role="status" className="mt-6 text-sm text-fg-muted">
          Checking every shared session…
        </p>
      )}
      {!loading && failure === null && failed.length === 0 && waiting.length === 0 && (
        <EmptyState
          title="You're all caught up"
          detail="No unanswered approvals or questions across your shared projects. Your agents can keep working."
          action={<CheckCheck size={22} className="text-success" />}
        />
      )}
      {failed.length > 0 && (
        <p role="alert" className="error-banner">
          {failed.length} session{failed.length === 1 ? '' : 's'} could not be checked. Open them to
          retry.
        </p>
      )}
      <div className="mt-5 space-y-3">
        {[...waiting, ...failed.filter((item) => !waiting.includes(item))].map((item) => (
          <button
            type="button"
            key={item.sessionId}
            onClick={() => onOpen(item.sessionId)}
            className="block w-full rounded-2xl border border-border bg-surface-1 p-4 text-left"
          >
            <span className="mb-3 flex items-center justify-between text-xs text-warning">
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={14} />
                {item.pendingApprovals.length > 0
                  ? `${item.pendingApprovals.length} approval${item.pendingApprovals.length === 1 ? '' : 's'}`
                  : item.pendingInputs.length > 0
                    ? 'Question from your agent'
                    : 'Could not check'}
              </span>
              <ArrowUpRight size={15} />
            </span>
            <span className="block truncate text-[15px] font-medium">
              {item.title || 'Untitled session'}
            </span>
            <span className="mt-1 block text-xs text-fg-subtle">
              {app.projects.find((project) => project.id === item.projectId)?.name ??
                'Shared project'}{' '}
              · {relativeTime(item.updatedAt)}
            </span>
            <span className="mt-3 line-clamp-3 block border-t border-border pt-3 text-sm leading-relaxed text-fg-muted">
              {item.error ??
                (item.pendingApprovals[0] === undefined
                  ? item.pendingInputs[0]?.prompt
                  : `${item.pendingApprovals[0].toolName}: ${summarizeToolDetail(item.pendingApprovals[0].summaryJson)}`)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

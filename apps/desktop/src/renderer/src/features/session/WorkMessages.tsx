import { useEffect, useRef, useState } from 'react'
import type { OrchestrationResults } from '@ari/contracts/orchestration'
import { invokeWork, workButton } from './work-actions'

const labels = {
  pending: 'In inbox',
  delivering: 'Delivering',
  delivered: 'Delivered to live turn',
  consumed: 'Consumed by agent',
  uncertain: 'Delivery uncertain',
}

/** Reading the inspector never acknowledges a message on an agent's behalf. */
export function WorkMessages({
  sessionId,
  taskId,
  observedAt,
}: {
  sessionId: string
  taskId?: string
  observedAt: number
}) {
  const [inbox, setInbox] = useState<OrchestrationResults['orchestration.inbox'] | null>(null)
  const [includeConsumed, setIncludeConsumed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const request = ++generation.current
    setError(null)
    void invokeWork('orchestration.inbox', {
      sessionId,
      ...(taskId ? { taskId } : {}),
      includeConsumed,
      limit: 40,
    })
      .then((result) => {
        if (request === generation.current) setInbox(result)
      })
      .catch((cause) => {
        if (request === generation.current)
          setError(cause instanceof Error ? cause.message : 'Could not load messages.')
      })
    return () => {
      generation.current += 1
    }
  }, [sessionId, taskId, includeConsumed, observedAt, refresh])
  return (
    <section aria-label="Agent messages" className="px-2 py-2 text-xs">
      <p className="mb-3 text-2xs leading-relaxed text-fg-subtle">
        Coordination notes stay in the recipient inbox until the agent reads and acknowledges them.
        Live delivery depends on the provider connection.
      </p>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-2xs text-fg-muted">
          <input
            type="checkbox"
            checked={includeConsumed}
            onChange={(event) => setIncludeConsumed(event.target.checked)}
          />
          Include consumed messages
        </label>
        <button
          type="button"
          className={workButton}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh messages
        </button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-danger">
          {error}
        </p>
      ) : null}
      {!inbox && !error ? (
        <p role="status" className="text-fg-subtle">
          Loading messages…
        </p>
      ) : null}
      {inbox ? (
        <>
          {inbox.total > inbox.messages.length ? (
            <p className="mb-2 text-2xs text-fg-subtle">
              Showing {inbox.messages.length} of {inbox.total} messages, newest first.
            </p>
          ) : null}
          {inbox.messages.length ? (
            <ul>
              {inbox.messages.map((message) => (
                <li key={message.messageId} className="border-b border-border/50 py-3">
                  <p className="break-words text-2xs font-medium text-fg">
                    {message.senderTitle} → {message.recipientTitle}
                  </p>
                  <p
                    className={`mt-1 text-2xs ${message.status === 'uncertain' ? 'text-warning' : 'text-fg-subtle'}`}
                  >
                    {labels[message.status]} · {new Date(message.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-fg-muted">
                    {message.text}
                  </p>
                  {message.textTruncated ? (
                    <p className="mt-1 text-2xs text-fg-subtle">
                      Preview truncated. The full note remains in the agent inbox.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-fg-subtle">No unread coordination messages.</p>
          )}
        </>
      ) : null}
    </section>
  )
}

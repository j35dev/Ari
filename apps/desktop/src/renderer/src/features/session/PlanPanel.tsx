import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleDashed, ListTodo } from 'lucide-react'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

type PlanItems = RpcResults['plan.get']['items']

/** The provider's checklist. Delegated work lives in the optional Work panel. */
export function PlanPanel({
  sessionId,
  refreshNonce,
}: {
  sessionId: string | null
  refreshNonce?: number
}) {
  const [items, setItems] = useState<PlanItems>(null)
  const [expanded, setExpanded] = useState(true)
  useEffect(() => {
    setItems(null)
    if (sessionId === null) return
    let cancelled = false
    void rpc
      .invoke('plan.get', { sessionId })
      .then((result) => {
        if (!cancelled) setItems(result.items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshNonce])
  if (items === null || items.length === 0) return null
  return (
    <div className="ari-chat-column flex flex-col gap-2 pt-3">
      <PlanCard items={items} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />
    </div>
  )
}

function PlanCard({
  items,
  expanded,
  onToggle,
}: {
  items: NonNullable<PlanItems>
  expanded: boolean
  onToggle: () => void
}) {
  const done = items.filter((item) => item.status === 'done').length
  return (
    <div className="rounded-lg border border-border bg-surface-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ListTodo size={13} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
          Plan
          {done === items.length ? ' — complete' : ''}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
          {done}/{items.length}
        </span>
        {expanded ? (
          <ChevronUp size={12} className="shrink-0 text-fg-subtle" aria-hidden />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-fg-subtle" aria-hidden />
        )}
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-1 border-t border-border px-3 py-2">
          {items.map((item, index) => (
            <li key={`${index}-${item.text}`} className="flex items-start gap-2">
              {item.status === 'done' ? (
                <CircleCheck size={13} className="mt-0.5 shrink-0 text-success" aria-hidden />
              ) : item.status === 'in_progress' ? (
                <Circle
                  size={13}
                  className="mt-0.5 shrink-0 animate-pulse text-busy"
                  fill="currentColor"
                  aria-hidden
                />
              ) : (
                <CircleDashed size={13} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
              )}
              <span
                className={`min-w-0 flex-1 break-words text-xs leading-relaxed ${
                  item.status === 'done' ? 'text-fg-subtle line-through' : 'text-fg-muted'
                }`}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

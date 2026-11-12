import { useEffect, useState } from 'react'
import { ChevronRight, ListTodo } from 'lucide-react'
import type { RpcResults } from '@ari/contracts/rpc'
import { useSessionClient } from './session-client'

type PlanItems = RpcResults['plan.get']['items']
type PlanStatus = NonNullable<PlanItems>[number]['status']

/** A step's place in the shared status vocabulary (styles/frame.css). */
const PLAN_GLYPH: Record<PlanStatus, string> = {
  done: 'done',
  in_progress: 'working',
  pending: 'queued',
}

/** The provider's checklist. Delegated work lives in the transcript and composer. */
export function PlanPanel({
  sessionId,
  refreshNonce,
}: {
  sessionId: string | null
  refreshNonce?: number
}) {
  const rpc = useSessionClient()
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
  }, [sessionId, refreshNonce, rpc, rpc.authorizationEpoch])
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
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left text-[13.5px] transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ListTodo size={14} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 truncate font-medium text-fg">
          Plan
          {done === items.length ? ' — complete' : ''}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
          {done}/{items.length}
        </span>
        <ChevronRight
          size={14}
          className={`ms-auto shrink-0 text-fg-subtle transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>
      {expanded ? (
        // One hairline carries the steps; the status glyph says where each is.
        <ul className="ms-[7px] flex flex-col border-s border-border py-0.5 ps-4">
          {items.map((item, index) => (
            <li key={`${index}-${item.text}`} className="flex items-start gap-2.5 py-1">
              <span
                aria-hidden
                className="ari-status mt-[3px]"
                data-status={PLAN_GLYPH[item.status]}
              />
              <span
                className={`min-w-0 flex-1 break-words text-[13.5px] leading-snug ${
                  item.status === 'done'
                    ? 'text-fg-subtle'
                    : item.status === 'in_progress'
                      ? 'text-fg'
                      : 'text-fg-muted'
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

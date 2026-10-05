import type { ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'

/** A quiet empty state with an optional next action. */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-14 text-center">
      <span className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-border bg-surface-1 text-fg-muted">
        <MessageSquare size={22} />
      </span>
      <h2 className="text-base font-medium tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">{detail}</p>
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  )
}

import { Spinner } from '@ari/ui/spinner'
import type { StatusTone } from './provider-status'

const DOT_CLASS: Partial<Record<StatusTone, string>> = {
  ok: 'bg-success',
  update: 'bg-accent',
  warning: 'bg-warning',
  error: 'bg-danger',
}

/** A coloured dot for states with a verdict, a spinner while one is pending. */
export function StatusDot({ tone }: { tone: StatusTone }) {
  if (tone === 'busy') return <Spinner className="mt-0.5 h-3 w-3 shrink-0" />
  const dot = DOT_CLASS[tone]
  if (dot === undefined) return null
  return (
    <span aria-hidden className="flex h-[1.5em] shrink-0 items-center">
      <span className={`block size-1.5 rounded-full ${dot}`} />
    </span>
  )
}

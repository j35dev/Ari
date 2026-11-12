import type { StatusTone } from './provider-status'

/**
 * Provider tones in the app's one status vocabulary (styles/frame.css). An
 * update and a warning are both "needs you"; the headline beside the glyph
 * says which.
 */
const STATUS: Partial<Record<StatusTone, 'done' | 'attention' | 'error' | 'working'>> = {
  ok: 'done',
  update: 'attention',
  warning: 'attention',
  error: 'error',
  busy: 'working',
}

/**
 * The status glyph for states with a verdict or one pending; nothing for
 * quiet ones. Sized to sit on the first line of 13px copy.
 */
export function StatusDot({ tone }: { tone: StatusTone }) {
  const status = STATUS[tone]
  if (status === undefined) return null
  return (
    <span aria-hidden className="flex h-5 shrink-0 items-center">
      <span className="ari-status" data-status={status} />
    </span>
  )
}

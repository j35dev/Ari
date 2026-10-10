import type { ProviderAllowance } from '@ari/contracts/rpc'

/** A window this full is the one that stopped the turn. */
const EXHAUSTED_PERCENT = 99

/**
 * When a session stopped by a usage limit can run again: the moment the last
 * of the provider's exhausted windows resets. Null when no window is
 * exhausted or none says when it resets — a brief rate limit has no reset to
 * wait for, and Retry is the right action there.
 */
export function resumeTime(allowance: ProviderAllowance, now: number): number | null {
  if (allowance.status !== 'available') return null
  const resets = allowance.windows
    .filter((window) => window.usedPercent >= EXHAUSTED_PERCENT)
    .map((window) => window.resetsAt)
  if (resets.length === 0 || resets.some((at) => at === null || at <= now)) return null
  return Math.max(...(resets as number[]))
}

/** `3:42 PM`, or `Tue 3:42 PM` when that is not today. */
export function formatResumeTime(at: number, now: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return when.toDateString() === new Date(now).toDateString()
    ? time
    : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

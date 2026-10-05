import type { ConnectionState } from './session'

/** Short, human labels for the states the client keeps distinct. */

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'reconnecting':
      return 'Reconnecting'
    case 'revoked':
      return 'Access revoked'
    case 'unknown-device':
      return 'Needs pairing'
    case 'version-mismatch':
      return 'Version mismatch'
    case 'unreachable':
      return 'Unreachable'
    default:
      return 'Not paired'
  }
}

/** "8:48 PM" — the clock time beside a message or under a group. */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "2m ago", "3h ago", "just now" — relative, because a phone is never precise. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * The tool detail behind an approval, rendered as text rather than as markup:
 * it arrives as JSON written by the provider, and a phone that executes it
 * would be reading a command the agent is still asking permission to run.
 */
export function summarizeToolDetail(summaryJson: string): string {
  try {
    const parsed: unknown = JSON.parse(summaryJson)
    if (typeof parsed === 'string') return parsed
    if (parsed !== null && typeof parsed === 'object') {
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => value !== null && value !== undefined)
        .slice(0, 4)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      if (entries.length > 0) return entries.join('\n')
    }
  } catch {
    // Not JSON: the provider wrote something else, and showing it verbatim is
    // still better than showing nothing next to a permission request.
  }
  return summaryJson
}

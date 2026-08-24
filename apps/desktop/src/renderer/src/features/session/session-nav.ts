import type { SessionSummary } from '@ari/contracts/rpc'

/**
 * Canonical visible-session order: pinned first, then newest. Archived
 * sessions are excluded — they live in their own collapsed shelf. Shared by
 * the sidebar rendering and the Mod+1..9 / Ctrl+Tab navigation so keyboard
 * order always matches what the user sees.
 */
export function sidebarOrder(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions]
    .filter((s) => !s.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
}

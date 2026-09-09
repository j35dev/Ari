import { useSyncExternalStore } from 'react'

/** localStorage key holding the sidebar presentation. */
export const SIDEBAR_VIEW_STORAGE_KEY = 'ari.sidebar.view'

/** `projects` nests sessions under their project; `sessions` is one flat recency list. */
export type SidebarView = 'projects' | 'sessions'

const listeners = new Set<() => void>()

/**
 * In-memory override when localStorage writes fail (quota, private mode).
 * Without it a failed persist notifies subscribers while reads still return
 * the old value, so the view controls silently stop responding.
 */
let memoryView: SidebarView | null = null

/** The persisted view; localStorage is the single source so tests reset it with `clear()`. */
export function sidebarView(): SidebarView {
  if (memoryView !== null) return memoryView
  if (typeof localStorage === 'undefined') return 'projects'
  return localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === 'sessions' ? 'sessions' : 'projects'
}

/**
 * Sidebar presentation, shared with keyboard navigation so Mod+1..9 / Ctrl+Tab
 * walk the same order the user sees. Persisted across restarts.
 */
export function useSidebarView(): { view: SidebarView; setView: (next: SidebarView) => void } {
  const view = useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, sidebarView)
  return {
    view,
    setView: (next) => {
      try {
        localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, next)
        memoryView = null
      } catch {
        // Quota or private-mode failures must never break sidebar rendering:
        // hold the choice in memory so reads agree with the notified view.
        memoryView = next
      }
      for (const listener of listeners) listener()
    },
  }
}

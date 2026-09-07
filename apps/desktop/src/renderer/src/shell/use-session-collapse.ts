import { useSyncExternalStore } from 'react'

let collapsed: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
export const collapsedSessions = (): ReadonlySet<string> => collapsed

/** Session expansion is shared with keyboard navigation for the current window. */
export function useSessionCollapse() {
  const value = useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, collapsedSessions)
  return {
    collapsed: value,
    toggle: (id: string) => {
      const next = new Set(collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      collapsed = next
      for (const listener of listeners) listener()
    },
  }
}

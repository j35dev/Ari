import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * A page with unsaved edits (the Agents editor) can stop settings from
 * switching section or closing under it. The guard gets the navigation as a
 * callback: it returns true when it took over (it asks, then runs `proceed`
 * itself if the user discards), false to let it through.
 */
export type LeaveGuard = (proceed: () => void) => boolean

export interface LeaveGuardStore {
  current: LeaveGuard | null
}

export function createLeaveGuardStore(): LeaveGuardStore {
  return { current: null }
}

/** Runs `action` unless the registered guard intercepts it. */
export function guardedLeave(store: LeaveGuardStore, action: () => void): void {
  if (store.current?.(action) === true) return
  action()
}

export const LeaveGuardContext = createContext<LeaveGuardStore | null>(null)

/** Registers `guard` while it is non-null. Outside settings it does nothing. */
export function useLeaveGuard(guard: LeaveGuard | null): void {
  const store = useContext(LeaveGuardContext)
  const latest = useRef(guard)
  latest.current = guard
  const active = guard !== null
  useEffect(() => {
    if (store === null || !active) return
    const registered: LeaveGuard = (proceed) => latest.current?.(proceed) ?? false
    store.current = registered
    return () => {
      if (store.current === registered) store.current = null
    }
  }, [store, active])
}

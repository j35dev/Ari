import { useSyncExternalStore } from 'react'

/**
 * The order the user dragged the Sessions view's cards into. Sessions not in
 * it yet (new ones) lead, newest first; the rest keep the place they were
 * given even when they get new activity. A preference for this machine, so
 * localStorage, cheap to lose.
 */
const KEY = 'ari.sidebar.sessionOrder.v1'
/** Enough for any real sidebar; older entries fall off the end. */
const LIMIT = 1000

/** Parsed once per stored string, so a snapshot keeps its identity until it changes. */
let cached: { raw: string | null; order: readonly string[] } = { raw: null, order: [] }
const listeners = new Set<() => void>()

function stored(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function readSessionOrder(): readonly string[] {
  const raw = stored()
  if (raw === cached.raw) return cached.order
  let order: string[] = []
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    if (Array.isArray(value)) order = value.filter((id): id is string => typeof id === 'string')
  } catch {
    /* A damaged entry reads as no arrangement. */
  }
  cached = { raw, order }
  return order
}

function writeSessionOrder(order: readonly string[]): void {
  const next = order.slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* Quota or privacy failures only cost the arrangement. */
  }
  cached = { raw: stored(), order: next }
  for (const listener of listeners) listener()
}

/** Drops the parsed copy; storage stays the source of truth either way. */
export function resetSessionOrderCache(): void {
  cached = { raw: null, order: [] }
}

/**
 * Puts recency-sorted `sessions` in the saved order: unplaced sessions first
 * in their recency order, then the placed ones as arranged.
 */
export function applySessionOrder<T extends { id: string }>(
  sessions: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...sessions]
  const rank = new Map(order.map((id, index) => [id, index]))
  const unplaced = sessions.filter((session) => !rank.has(session.id))
  const placed = sessions
    .filter((session) => rank.has(session.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...unplaced, ...placed]
}

/**
 * Moves `dragged` before or after `target` within one section, whose current
 * on-screen order is `visible`. The whole section is saved, so every card in
 * it keeps the place it has now.
 */
export function moveSession(
  visible: readonly string[],
  dragged: string,
  target: string,
  place: 'before' | 'after',
): void {
  if (dragged === target || !visible.includes(dragged) || !visible.includes(target)) return
  const rest = visible.filter((id) => id !== dragged)
  const at = rest.indexOf(target) + (place === 'after' ? 1 : 0)
  const section = [...rest.slice(0, at), dragged, ...rest.slice(at)]
  const others = readSessionOrder().filter((id) => !section.includes(id))
  writeSessionOrder([...section, ...others])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The saved order, re-read by every view when a drag changes it. */
export function useSessionOrder(): readonly string[] {
  return useSyncExternalStore(subscribe, readSessionOrder, readSessionOrder)
}

/** The card being dragged, which `dragover` cannot read from the payload. */
let draggingId: string | null = null
export const sessionDrag = {
  start(id: string): void {
    draggingId = id
  },
  end(): void {
    draggingId = null
  },
  get current(): string | null {
    return draggingId
  },
}

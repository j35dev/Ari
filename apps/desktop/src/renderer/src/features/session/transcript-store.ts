import { useRef, useSyncExternalStore } from 'react'
import type { Message } from '@ari/contracts/message'
import { createMessageFold, type MessageFold } from './message-fold'

/**
 * One session's message list, held outside React so a streaming flush
 * re-renders only the components that read messages (the transcript and a
 * few selectors) instead of the whole session view.
 *
 * Stores are module-level and outlive the view that fills them: the most
 * recently used {@link TRANSCRIPT_CACHE_SIZE} sessions keep their last
 * snapshot (beyond any that a mounted view is still subscribed to), so a view mounted for a session opened recently can paint its
 * transcript at once while the journal replay rebuilds it underneath.
 *
 * Lifecycle, as `SessionView` drives it:
 * 1. `transcriptStore(id)` on mount / session switch.
 * 2. `begin()` before subscribing to the journal. It returns a fresh fold
 *    for that subscription's events; the previous snapshot stays readable
 *    until the replay commits. A writer holding an older fold can no longer
 *    reach the list.
 * 3. `publish()` after each journal frame.
 */
export interface TranscriptStore {
  readonly sessionId: string
  /** Starts the fold journal events land in; the current snapshot stays until the next publish. */
  begin(): MessageFold
  /** Commits the fold and notifies subscribers when the list changed. */
  publish(): void
  /** The latest published list. Immutable; same identity until it changes. */
  getSnapshot: () => Message[]
  subscribe: (listener: () => void) => () => void
}

/** How many sessions keep their transcript after their view goes away. */
export const TRANSCRIPT_CACHE_SIZE = 12

const NO_MESSAGES: Message[] = []
const stores = new Map<string, TranscriptStore>()
/** How many subscribers each store has; a watched store is never evicted. */
const watchers = new WeakMap<TranscriptStore, number>()

function createStore(sessionId: string): TranscriptStore {
  let fold = createMessageFold()
  let snapshot = NO_MESSAGES
  // A fresh fold's first publish replaces the cached snapshot even when the
  // replay brought nothing, or an emptied list would keep showing old rows.
  let replacing = false
  const listeners = new Set<() => void>()
  const store: TranscriptStore = {
    sessionId,
    begin() {
      fold = createMessageFold()
      replacing = true
      return fold
    },
    publish() {
      const next = fold.commit() ?? (replacing && snapshot.length > 0 ? NO_MESSAGES : null)
      replacing = false
      if (next === null) return
      snapshot = next
      for (const listener of listeners) listener()
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      watchers.set(store, listeners.size)
      return () => {
        listeners.delete(listener)
        watchers.set(store, listeners.size)
      }
    },
  }
  return store
}

/** The store for `sessionId`, created on first use and marked most recent. */
export function transcriptStore(sessionId: string): TranscriptStore {
  let store = stores.get(sessionId)
  if (store === undefined) store = createStore(sessionId)
  else stores.delete(sessionId)
  stores.set(sessionId, store)
  // Oldest first, skipping stores a mounted view still reads: evicting one
  // would hand the next caller a second store for the same session.
  for (const [id, candidate] of stores) {
    if (stores.size <= TRANSCRIPT_CACHE_SIZE) break
    if ((watchers.get(candidate) ?? 0) === 0) stores.delete(id)
  }
  return store
}

/** Subscribes to a store's whole list; re-renders on every published change. */
export function useTranscriptMessages(store: TranscriptStore): Message[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/**
 * Subscribes to a value derived from a store's list. The component re-renders
 * only when `isEqual` says the value changed, so a selector can watch the
 * user's prompts without waking on every streamed delta. `select` must be a
 * pure function of the list.
 */
export function useTranscriptSelector<T>(
  store: TranscriptStore,
  select: (messages: Message[]) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ store: TranscriptStore; list: Message[]; value: T } | null>(null)
  const read = (): T => {
    const list = store.getSnapshot()
    const hit = cache.current
    if (hit !== null && hit.store === store && hit.list === list) return hit.value
    const value = select(list)
    const kept =
      hit !== null && hit.store === store && isEqual(hit.value, value) ? hit.value : value
    cache.current = { store, list, value: kept }
    return kept
  }
  return useSyncExternalStore(store.subscribe, read)
}

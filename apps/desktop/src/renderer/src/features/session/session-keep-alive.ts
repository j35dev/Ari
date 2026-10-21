import { useMemo, useSyncExternalStore } from 'react'
import { TRANSCRIPT_CACHE_SIZE } from './transcript-store'

/**
 * How many recently shown sessions stay mounted, across every pane together.
 * Each one holds its transcript DOM and a live journal subscription, so the
 * budget is global rather than per pane. It matches the transcript cache, so
 * a session that falls out of here can still repaint from its store.
 */
export const KEEP_ALIVE_LIMIT = TRANSCRIPT_CACHE_SIZE

/** One session a pane has shown, kept mounted so returning to it is instant. */
export interface KeptSession {
  poolId: string
  sessionId: string
}

/**
 * Marks a session as just shown in a pool. It moves to the front; anything
 * past the limit falls off the back. A session lives in one pool at a time:
 * shown somewhere new, its hidden copy elsewhere is dropped, so the same
 * journal is never folded twice off screen.
 */
export function retain(
  entries: readonly KeptSession[],
  poolId: string,
  sessionId: string,
  limit = KEEP_ALIVE_LIMIT,
): readonly KeptSession[] {
  const head = entries[0]
  if (head?.poolId === poolId && head.sessionId === sessionId) return entries
  return [{ poolId, sessionId }, ...entries.filter((e) => e.sessionId !== sessionId)].slice(
    0,
    limit,
  )
}

/** Drops whatever `keep` rejects, returning the same list when nothing goes. */
export function prune(
  entries: readonly KeptSession[],
  keep: (entry: KeptSession) => boolean,
): readonly KeptSession[] {
  const next = entries.filter(keep)
  return next.length === entries.length ? entries : next
}

let kept: readonly KeptSession[] = []
const listeners = new Set<() => void>()

function commit(next: readonly KeptSession[]): void {
  if (next === kept) return
  kept = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Writers for the shared keep-alive list. */
export const keepAliveActions = {
  retain: (poolId: string, sessionId: string): void => commit(retain(kept, poolId, sessionId)),
  /** A pool that unmounts takes its hidden sessions with it. */
  releasePool: (poolId: string): void => commit(prune(kept, (e) => e.poolId !== poolId)),
  /** Sessions that no longer exist must not stay mounted behind the pane. */
  keepOnly: (sessionIds: ReadonlySet<string>): void =>
    commit(prune(kept, (e) => sessionIds.has(e.sessionId))),
  /** Test seam: forget everything. */
  reset: (): void => commit([]),
}

/** The sessions one pool keeps mounted, newest first. */
export function useKeptSessions(poolId: string): readonly string[] {
  const entries = useSyncExternalStore(subscribe, () => kept)
  return useMemo(
    () => entries.filter((e) => e.poolId === poolId).map((e) => e.sessionId),
    [entries, poolId],
  )
}

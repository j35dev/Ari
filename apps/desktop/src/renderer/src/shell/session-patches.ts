import type { SessionSummary } from '@ari/contracts/rpc'

/** The sidebar fields a click changes before the engine has confirmed it. */
export type SessionPatch = Partial<Pick<SessionSummary, 'title' | 'pinned' | 'archived'>>

/**
 * A change shown ahead of its round trip. Once the engine accepts it,
 * `settledAt` holds the generation of the list fetched afterwards: that list
 * is the first one guaranteed to carry the change, so the patch can go.
 */
export interface PendingPatch {
  token: number
  sessionId: string
  patch: SessionPatch
  settledAt?: number
}

/** The listed sessions with every outstanding patch applied, oldest first. */
export function applyPatches(
  listed: SessionSummary[],
  patches: readonly PendingPatch[],
): SessionSummary[] {
  if (patches.length === 0) return listed
  return listed.map((session) => {
    let next = session
    for (const pending of patches) {
      if (pending.sessionId === session.id) next = { ...next, ...pending.patch }
    }
    return next
  })
}

/** Drops the patches a list of generation `generation` already reflects. */
export function dropSettled(
  patches: readonly PendingPatch[],
  generation: number,
): readonly PendingPatch[] {
  const next = patches.filter((p) => p.settledAt === undefined || p.settledAt > generation)
  return next.length === patches.length ? patches : next
}

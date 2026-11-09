import type { DriverKind } from '@ari/contracts/common'
import { ControlFailure } from '@ari/contracts/agent-control'

interface EffortOption {
  id: string
  label?: string
  current?: boolean
}

/** Launches need verified support. A failed discovery must never become a cached empty answer. */
export function launchEffortLookup(deps: {
  known(kind: DriverKind, modelId: string | null): readonly EffortOption[] | undefined
  probe(kind: DriverKind, modelId: string | null): Promise<readonly EffortOption[]>
}) {
  const pending = new Map<string, Promise<readonly EffortOption[]>>()
  return (kind: DriverKind, modelId: string | null): Promise<readonly EffortOption[]> => {
    const known = deps.known(kind, modelId)
    if (known !== undefined) return Promise.resolve(known)
    const key = `${kind}\n${modelId ?? ''}`
    const existing = pending.get(key)
    if (existing) return existing
    const answer = deps.probe(kind, modelId).catch((error: unknown) => {
      pending.delete(key)
      throw new ControlFailure(
        'effort_unavailable',
        `Could not verify reasoning effort support for ${kind}/${modelId ?? 'default'}: ${error instanceof Error ? error.message : String(error)}. Retry discovery before launching.`,
      )
    })
    pending.set(key, answer)
    return answer
  }
}

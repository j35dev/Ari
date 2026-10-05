import { createLogger } from '@ari/shared/logger'
import type { DriverKind } from '@ari/contracts/common'
import type { RemoteEffortOption } from '@ari/contracts/remote'

const log = createLogger('remote-efforts')

type EffortLookup = (kind: DriverKind, modelId: string | null) => Promise<RemoteEffortOption[]>

/**
 * Asking an agent for one model's effort levels starts a process, and a phone
 * asks every time its picker opens. Answers are kept for the life of the
 * desktop; a failed ask is not, so the next one tries again.
 */
export function cachedEffortLookup(probe: EffortLookup): EffortLookup {
  const answers = new Map<string, Promise<RemoteEffortOption[]>>()
  return (kind, modelId) => {
    const key = `${kind}\n${modelId ?? ''}`
    const known = answers.get(key)
    if (known !== undefined) return known
    const asked = probe(kind, modelId).catch((error: unknown) => {
      answers.delete(key)
      log.debug('model-specific effort probe failed', { kind, error: String(error) })
      return []
    })
    answers.set(key, asked)
    return asked
  }
}

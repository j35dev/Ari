import { driverKindSchema } from '@ari/contracts/common'
import type { DriverKind } from '@ari/contracts/common'

/**
 * The agent, model and reasoning level the user last chose in a composer.
 * New sessions start from it, so a pick is made once rather than in every
 * session. Kept in localStorage: it is a preference for this machine, cheap
 * to lose and never secret.
 */
export interface LastPick {
  driverKind: DriverKind
  modelId: string | null
  effort: string | null
}

const STORAGE_KEY = 'ari.composer.last-pick'

/** The remembered pick, or null when there is none or it no longer parses. */
export function loadLastPick(storage: Storage | null = safeLocalStorage()): LastPick | null {
  if (storage === null) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as { driverKind?: unknown; modelId?: unknown; effort?: unknown }
    const kind = driverKindSchema.safeParse(value.driverKind)
    if (!kind.success) return null
    return {
      driverKind: kind.data,
      modelId: typeof value.modelId === 'string' && value.modelId.length > 0 ? value.modelId : null,
      effort: typeof value.effort === 'string' && value.effort.length > 0 ? value.effort : null,
    }
  } catch {
    return null
  }
}

/**
 * Folds one composer change into the remembered pick. A different agent
 * starts its level over: one agent's `xhigh` means nothing to another.
 */
export function nextLastPick(current: LastPick, change: Partial<LastPick>): LastPick {
  const driverKind = change.driverKind ?? current.driverKind
  const switched = driverKind !== current.driverKind
  return {
    driverKind,
    modelId: change.modelId !== undefined ? change.modelId : current.modelId,
    effort: change.effort !== undefined ? change.effort : switched ? null : current.effort,
  }
}

export function saveLastPick(pick: LastPick, storage: Storage | null = safeLocalStorage()): void {
  if (storage === null) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pick))
  } catch {
    // Quota/privacy failures only cost the convenience.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

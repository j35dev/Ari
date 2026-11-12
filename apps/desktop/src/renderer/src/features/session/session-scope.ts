export type SessionScope =
  | { readonly kind: 'local'; readonly sessionId: string }
  | { readonly kind: 'remote'; readonly machineId: string; readonly sessionId: string }

/** Existing engine ids remain unchanged; remote ids are the exact registry/wire tuple. */
export function sessionViewKey(scope: SessionScope): string {
  return scope.kind === 'local' ? scope.sessionId : JSON.stringify([scope.machineId, scope.sessionId])
}

/** Only engine-issued local ids and canonical remote tuples are accepted for navigation. */
export function parseSessionViewKey(key: string): SessionScope | null {
  if (/^sess_[A-Za-z0-9_-]+$/.test(key)) return { kind: 'local', sessionId: key }
  try {
    const value: unknown = JSON.parse(key)
    if (!Array.isArray(value) || value.length !== 2 ||
      !value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) ||
      JSON.stringify(value) !== key) return null
    return { kind: 'remote', machineId: value[0] as string, sessionId: value[1] as string }
  } catch { return null }
}

const invalidators = new Set<(machineId: string) => void>()
export function registerSessionCacheInvalidator(callback: (machineId: string) => void): () => void {
  invalidators.add(callback)
  return () => { invalidators.delete(callback) }
}
export function invalidateMachineSessionCaches(machineId: string): void {
  for (const callback of invalidators) callback(machineId)
}

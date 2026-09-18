/**
 * The new session's id from a `session.create` answer.
 *
 * Command answers carry the host's own envelope inside the gateway's:
 * `{ ok, result: { sessionId } }`. Reading the outer layer reports a failure
 * for a session that was actually created, and the retry makes a duplicate.
 */
export function sessionIdOf(result: unknown): string | null {
  if (result === null || typeof result !== 'object') return null
  const outer = result as Record<string, unknown>
  const direct = outer['sessionId']
  if (typeof direct === 'string' && direct.length > 0) return direct
  const inner = outer['result']
  if (inner === null || typeof inner !== 'object') return null
  const nested = (inner as Record<string, unknown>)['sessionId']
  return typeof nested === 'string' && nested.length > 0 ? nested : null
}

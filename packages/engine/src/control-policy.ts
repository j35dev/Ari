import { ControlFailure, type DelegationSettings } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'

/** Validated lineage from a session to its root; corrupt and cross-project trees fail closed. */
export async function sessionLineage(
  session: Session,
  get: (id: string) => Promise<Session | null>,
): Promise<Session[]> {
  const chain: Session[] = []
  let current: Session | null = session
  while (current) {
    if (chain.some((s) => s.id === current?.id) || current.projectId !== session.projectId) {
      throw new ControlFailure('scope_denied', 'Invalid session hierarchy.')
    }
    chain.push(current)
    if (!current.parentSessionId) return chain
    current = await get(current.parentSessionId)
  }
  throw new ControlFailure('scope_denied', 'Parent session is missing.')
}

/** Enforces spawn policy before workspace or provider side effects. */
export function checkDelegation(
  policy: DelegationSettings,
  depth: number,
  children: number,
  active: number,
): void {
  if (!policy.enabled) throw new ControlFailure('delegation_disabled', 'Delegation is disabled.')
  if (depth >= policy.maxDepth || (depth > 0 && !policy.recursiveDelegation)) {
    throw new ControlFailure('max_depth', 'Delegation depth limit reached.')
  }
  if (children >= policy.maxChildrenPerSession)
    throw new ControlFailure('max_children', 'Child session limit reached.')
  if (active >= policy.maxConcurrentChildren)
    throw new ControlFailure('delegation_limit', 'Maximum concurrent children reached.')
}

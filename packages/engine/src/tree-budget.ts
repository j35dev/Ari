import type { DelegationSettings } from '@ari/contracts/agent-control'
import type { SessionReadModel } from './projection'

/** Spend across one root's whole subtree, the lead included. */
export interface TreeSpend {
  tokens: number
  costUsd: number
  /** Sessions whose provider reported no price; their cost is not in `costUsd`. */
  unpricedSessions: number
  sessions: number
}

/** Folds a tree's read models into one spend figure. */
export function treeSpend(models: readonly SessionReadModel[]): TreeSpend {
  let tokens = 0
  let costUsd = 0
  let unpricedSessions = 0
  for (const model of models) {
    tokens += model.usage.inputTokens + model.usage.outputTokens
    if (model.usage.costUsd === null) unpricedSessions += 1
    else costUsd += model.usage.costUsd
  }
  return { tokens, costUsd, unpricedSessions, sessions: models.length }
}

/** Which cap a spend has reached, if any. Tokens are checked first because they always exist. */
export function budgetExceeded(
  policy: Pick<DelegationSettings, 'maxTreeCostUsd' | 'maxTreeTokens'>,
  spend: TreeSpend,
): 'cost' | 'tokens' | null {
  if (policy.maxTreeTokens !== null && spend.tokens >= policy.maxTreeTokens) return 'tokens'
  if (policy.maxTreeCostUsd !== null && spend.costUsd >= policy.maxTreeCostUsd) return 'cost'
  return null
}

/**
 * One readable spend line for a lead's completion notice, or null when no cap
 * is set. Unpriced sessions are called out: their work is real even when no
 * provider put a price on it.
 */
export function budgetLine(
  spend: TreeSpend,
  policy: Pick<DelegationSettings, 'maxTreeCostUsd' | 'maxTreeTokens'>,
): string | null {
  if (policy.maxTreeCostUsd === null && policy.maxTreeTokens === null) return null
  const caps: string[] = []
  if (policy.maxTreeTokens !== null)
    caps.push(`${String(policy.maxTreeTokens)} tokens (used ${String(spend.tokens)})`)
  if (policy.maxTreeCostUsd !== null)
    caps.push(
      `$${policy.maxTreeCostUsd.toFixed(2)} (used $${spend.costUsd.toFixed(2)}${
        spend.unpricedSessions > 0 ? `, ${String(spend.unpricedSessions)} unpriced` : ''
      })`,
    )
  return `Tree spend: ${String(spend.tokens)} tokens, $${spend.costUsd.toFixed(2)}${
    spend.unpricedSessions > 0 ? ` (${String(spend.unpricedSessions)} unpriced)` : ''
  } across ${String(spend.sessions)} sessions. Caps: ${caps.join('; ')}.`
}

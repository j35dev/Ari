import { describe, expect, it } from 'vitest'
import type { SessionReadModel } from './projection'
import { budgetExceeded, budgetLine, treeSpend } from './tree-budget'

const model = (input: number, output: number, cost: number | null): SessionReadModel =>
  ({ usage: { inputTokens: input, outputTokens: output, costUsd: cost } }) as SessionReadModel

const policy = (maxTreeCostUsd: number | null, maxTreeTokens: number | null) => ({
  maxTreeCostUsd,
  maxTreeTokens,
})

describe('treeSpend', () => {
  it('sums tokens and prices, and counts unpriced sessions separately', () => {
    const spend = treeSpend([model(100, 50, 0.25), model(10, 5, null)])
    expect(spend).toEqual({ tokens: 165, costUsd: 0.25, unpricedSessions: 1, sessions: 2 })
  })

  it('treats an empty tree as zero', () => {
    expect(treeSpend([])).toEqual({ tokens: 0, costUsd: 0, unpricedSessions: 0, sessions: 0 })
  })
})

describe('budgetExceeded', () => {
  it('is off when both caps are null', () => {
    expect(budgetExceeded(policy(null, null), treeSpend([model(1_000_000, 0, 99)]))).toBeNull()
  })

  it('reaches a cap at equality, not only beyond it', () => {
    const spend = treeSpend([model(100, 50, 0.5)])
    expect(budgetExceeded(policy(null, 150), spend)).toBe('tokens')
    expect(budgetExceeded(policy(0.5, null), spend)).toBe('cost')
    expect(budgetExceeded(policy(null, 151), spend)).toBeNull()
  })

  it('checks tokens before cost so a Codex tree with no prices can still stop', () => {
    const spend = treeSpend([model(200, 0, null)])
    expect(budgetExceeded(policy(0.01, 200), spend)).toBe('tokens')
  })
})

it('writes a readable budget line with the unpriced count and both caps', () => {
  const line = budgetLine(treeSpend([model(100, 50, 0.25), model(10, 5, null)]), policy(2, 1_000))
  expect(line).toContain('165 tokens')
  expect(line).toContain('$0.25')
  expect(line).toContain('1 unpriced')
  expect(line).toContain('2 sessions')
  expect(line).toContain('1000 tokens')
  expect(line).toContain('$2.00')
  expect(budgetLine(treeSpend([]), policy(null, null))).toBeNull()
})

import { beforeEach, describe, expect, it } from 'vitest'
import { loadLastPick, nextLastPick, saveLastPick } from './last-pick'

describe('last pick', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips through storage', () => {
    saveLastPick({ driverKind: 'claude', modelId: 'opus', effort: 'xhigh' })
    expect(loadLastPick()).toEqual({ driverKind: 'claude', modelId: 'opus', effort: 'xhigh' })
  })

  it('ignores a missing, corrupt or unknown-agent entry', () => {
    expect(loadLastPick()).toBeNull()
    localStorage.setItem('ari.composer.last-pick', '{not json')
    expect(loadLastPick()).toBeNull()
    localStorage.setItem('ari.composer.last-pick', JSON.stringify({ driverKind: 'gone' }))
    expect(loadLastPick()).toBeNull()
  })

  it('keeps the level across a model change but not across an agent change', () => {
    const current = { driverKind: 'claude' as const, modelId: 'opus', effort: 'max' }
    expect(nextLastPick(current, { driverKind: 'claude', modelId: 'sonnet' })).toEqual({
      driverKind: 'claude',
      modelId: 'sonnet',
      effort: 'max',
    })
    expect(nextLastPick(current, { driverKind: 'codex', modelId: 'gpt-6-astra' })).toEqual({
      driverKind: 'codex',
      modelId: 'gpt-6-astra',
      effort: null,
    })
    expect(nextLastPick(current, { effort: null })).toEqual({ ...current, effort: null })
  })
})

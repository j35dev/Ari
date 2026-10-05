import { describe, expect, it } from 'vitest'
import { cachedEffortLookup } from './remote-efforts'

describe('per-model effort lookup for a phone', () => {
  it('asks the agent once per provider and model, however often a phone asks', async () => {
    const asked: string[] = []
    const lookup = cachedEffortLookup(async (kind, modelId) => {
      asked.push(`${kind}:${modelId}`)
      return [{ id: 'high', label: 'High' }]
    })

    const [first, second] = await Promise.all([lookup('codex', 'gpt'), lookup('codex', 'gpt')])
    await lookup('codex', 'gpt')
    await lookup('codex', null)

    expect(first).toEqual([{ id: 'high', label: 'High' }])
    expect(second).toBe(first)
    expect(asked).toEqual(['codex:gpt', 'codex:null'])
  })

  it('answers with no levels when the agent cannot be asked, and asks again next time', async () => {
    let attempts = 0
    const lookup = cachedEffortLookup(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('agent did not start')
      return [{ id: 'low', label: 'Low' }]
    })

    expect(await lookup('opencode', 'm')).toEqual([])
    expect(await lookup('opencode', 'm')).toEqual([{ id: 'low', label: 'Low' }])
  })
})

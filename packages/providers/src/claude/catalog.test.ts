import { describe, expect, it } from 'vitest'
import { claudeCatalog } from './catalog'

describe('Claude SDK catalog', () => {
  it('preserves default, explicit model aliases, and the advertised xhigh/max effort levels', () => {
    const catalog = claudeCatalog([
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'CLI default',
        description: 'The user setting',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-5-5',
        displayName: 'Haiku',
        description: 'Fast',
        supportsEffort: false,
      },
    ])
    expect(catalog.defaultModelId).toBe('claude-opus-5-5')
    expect(catalog.models[0]?.id).toBe('default')
    expect(catalog.models[1]?.aliases).toEqual(['claude-haiku-5-5'])
    expect(catalog.models[0]?.efforts?.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(catalog.models[1]?.efforts).toEqual([])
    expect(catalog.modes.options.map((mode) => mode.id)).toEqual([
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
    ])
  })
})

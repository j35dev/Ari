import { afterEach, describe, expect, it } from 'vitest'
import { clearDynamicModels, modelsFor, restoreLiveCatalog, setDynamicModels } from '../catalogs'
import { antigravitySessionModel } from './policy'

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet' },
  { id: 'gemini-3.8-flash', label: 'Gemini Flash', aliases: ['gemini-flash', 'claude'] },
]

afterEach(() => clearDynamicModels('antigravity'))

describe('Antigravity models supported in third-party ACP clients', () => {
  it('filters live and restored catalogs, including unsupported aliases', () => {
    setDynamicModels('antigravity', 'live', MODELS)
    expect(modelsFor('antigravity')).toEqual([
      { id: 'gemini-3.8-flash', label: 'Gemini Flash', aliases: ['gemini-flash'] },
    ])
    restoreLiveCatalog('antigravity', {
      models: MODELS,
      efforts: { currentId: null, options: [] },
      modes: { currentId: null, options: [] },
      defaultModelId: 'claude-sonnet-4-6',
    })
    expect(modelsFor('antigravity').map((model) => model.id)).toEqual(['gemini-3.8-flash'])
  })

  it.each([null, 'default'])('replaces a non-Gemini CLI default for %s', (requested) => {
    expect(antigravitySessionModel(requested, 'claude-sonnet-4-6', MODELS)).toBe('gemini-3.8-flash')
  })

  it('refuses explicit third-party picks and missing Gemini models', () => {
    expect(() => antigravitySessionModel('claude-sonnet-4-6', null, MODELS)).toThrow('Gemini')
    expect(() => antigravitySessionModel('gemini-missing', null, MODELS)).toThrow('does not offer')
    expect(() => antigravitySessionModel(null, 'claude-sonnet-4-6', MODELS.slice(0, 1))).toThrow(
      'no Gemini',
    )
  })
})

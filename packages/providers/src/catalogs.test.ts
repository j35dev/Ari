import { describe, expect, it } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { MODEL_CATALOGS, modelsFor } from './catalogs'

const ALL_KINDS: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes', 'ari-core']

describe('MODEL_CATALOGS', () => {
  it('has a list for every driver kind', () => {
    for (const kind of ALL_KINDS) {
      expect(Array.isArray(MODEL_CATALOGS[kind])).toBe(true)
    }
  })

  it('keeps labels unique within each kind', () => {
    for (const kind of ALL_KINDS) {
      const labels = MODEL_CATALOGS[kind].map((model) => model.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it('curates the claude and codex families', () => {
    expect(MODEL_CATALOGS.claude.map((model) => model.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
    ])
    expect(MODEL_CATALOGS.codex.map((model) => model.id)).toEqual(['gpt-5-codex', 'gpt-5-mini'])
  })

  it('ships a single default for flag-driven CLIs and leaves ari-core empty', () => {
    for (const kind of ['opencode', 'grok', 'pi', 'hermes'] as const) {
      expect(MODEL_CATALOGS[kind]).toEqual([{ id: 'default', label: 'CLI default' }])
    }
    expect(MODEL_CATALOGS['ari-core']).toEqual([])
  })
})

describe('modelsFor', () => {
  it('returns at least one entry for every kind that ships static models', () => {
    for (const kind of ALL_KINDS.filter((kind) => kind !== 'ari-core')) {
      expect(modelsFor(kind).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('returns no entries for ari-core because endpoints supply models', () => {
    expect(modelsFor('ari-core')).toEqual([])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import {
  catalogSource,
  clearDynamicEfforts,
  clearDynamicModels,
  clearDynamicModes,
  effortsFor,
  MODEL_CATALOGS,
  modelsFor,
  modesFor,
  setDynamicEfforts,
  setDynamicModels,
  setDynamicModes,
} from './catalogs'

const ALL_KINDS: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes', 'ari-core']

afterEach(() => {
  for (const kind of ALL_KINDS) {
    clearDynamicModels(kind)
    clearDynamicEfforts(kind)
    clearDynamicModes(kind)
  }
})

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

  it('ships a single default for flag-driven CLIs and leaves ari-core empty', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes'] as const) {
      expect(MODEL_CATALOGS[kind]).toEqual([{ id: 'default', label: 'CLI default' }])
    }
    expect(MODEL_CATALOGS['ari-core']).toEqual([])
  })
})

describe('modelsFor fallback chain', () => {
  it('returns at least one entry for every kind that ships models', () => {
    for (const kind of ALL_KINDS.filter((kind) => kind !== 'ari-core')) {
      expect(modelsFor(kind).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('returns no entries for ari-core because endpoints supply models', () => {
    expect(modelsFor('ari-core')).toEqual([])
  })

  it('falls back to the bundled snapshot for claude/codex/grok before static defaults', () => {
    // Snapshot data is generated from models.dev; ids drift by design, but
    // claude/codex/grok must always resolve to real model ids, not "default".
    for (const kind of ['claude', 'codex', 'grok'] as const) {
      const models = modelsFor(kind)
      expect(models.length).toBeGreaterThan(1)
      expect(models.some((m) => m.id === 'default')).toBe(false)
      expect(catalogSource(kind)).toBe('snapshot')
    }
  })

  it('prefers the dynamic overlay over the snapshot and reports its source', () => {
    setDynamicModels('claude', 'live', [{ id: 'claude-live-model', label: 'Live' }])
    expect(modelsFor('claude')).toEqual([{ id: 'claude-live-model', label: 'Live' }])
    expect(catalogSource('claude')).toBe('live')
  })

  it('ignores empty dynamic overlays instead of blanking a kind', () => {
    setDynamicModels('codex', 'live', [])
    expect(modelsFor('codex').length).toBeGreaterThan(1)
  })

  it('keeps CLI-default kinds on static until a live source lands', () => {
    for (const kind of ['opencode', 'pi', 'hermes'] as const) {
      expect(modelsFor(kind)).toEqual([{ id: 'default', label: 'CLI default' }])
      expect(catalogSource(kind)).toBe('static')
    }
  })

  it('scopes the snapshot to models the CLI currently serves', () => {
    // models.dev ships the whole vendor history; a picker showing gpt-3.5 or
    // claude-4-5-20250929 next to gpt-5.6 is what the filter exists to stop.
    const codex = modelsFor('codex').map((m) => m.id)
    expect(codex.length).toBeLessThan(39)
    // Codex's own visible catalog (bundled models.json, visibility=list).
    expect([...codex].sort()).toEqual(['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])
    expect(codex.some((id) => id.startsWith('gpt-4'))).toBe(false)
    expect(codex.some((id) => id.startsWith('o1') || id.startsWith('o3'))).toBe(false)

    const claude = modelsFor('claude').map((m) => m.id)
    expect(claude).toContain('claude-opus-5')
    expect(claude).not.toContain('claude-opus-4-5-20251101')

    const grok = modelsFor('grok').map((m) => m.id)
    expect(grok).toContain('grok-4.6')
    expect(grok.some((id) => id.startsWith('grok-4.20'))).toBe(false)
  })
})

describe('effortsFor', () => {
  it('ships Grok and Ari Core vocabularies before any probe', () => {
    expect(effortsFor('grok').options.map((o) => o.id)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(effortsFor('ari-core').options.map((o) => o.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortsFor('hermes').options).toEqual([])
  })

  it('lets a live probe replace the fallback', () => {
    setDynamicEfforts('grok', {
      currentId: 'low',
      options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
    })
    expect(effortsFor('grok').options.map((o) => o.id)).toEqual(['low', 'high'])
    setDynamicEfforts('grok', { currentId: null, options: [] })
    expect(effortsFor('grok').options.map((o) => o.id)).toContain('xhigh')
  })
})

describe('modesFor', () => {
  it('is empty for every kind until a probe classifies the agent vocabulary', () => {
    for (const kind of ALL_KINDS) {
      expect(modesFor(kind)).toEqual({ currentId: null, options: [] })
    }
  })

  it('carries the probe result, unclassified modes included', () => {
    setDynamicModes('codex', {
      currentId: 'yolo',
      options: [
        { id: 'chat', label: 'Chat', ariMode: 'ask' },
        { id: 'yolo', label: 'Yolo', ariMode: 'full' },
        { id: 'mystery', label: 'Mystery', ariMode: null },
      ],
    })
    expect(modesFor('codex').currentId).toBe('yolo')
    expect(modesFor('codex').options.map((o) => [o.id, o.ariMode])).toEqual([
      ['chat', 'ask'],
      ['yolo', 'full'],
      ['mystery', null],
    ])
    // The picker filter is the RPC layer's job; the overlay keeps raw data.
    setDynamicModes('codex', { currentId: null, options: [] })
    expect(modesFor('codex')).toEqual({ currentId: null, options: [] })
  })
})

import { describe, expect, it } from 'vitest'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { effortChoices, effortLabel, modeChoices, modeLabel } from './session-controls'

const catalog: RemoteModelCatalog = {
  providers: [
    {
      driverKind: 'codex',
      models: [],
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High', description: 'Thinks longer', current: true },
      ],
      modes: [
        { id: 'read-only', label: 'Read only', ariMode: 'ask' },
        { id: 'yolo', label: 'YOLO', description: 'No approvals', ariMode: 'full' },
      ],
    },
    { driverKind: 'claude', models: [], efforts: [], modes: [] },
    // A desktop too old to report either list.
    { driverKind: 'opencode', models: [] },
  ],
}

describe('effort choices', () => {
  it('offers the levels the provider reports', () => {
    expect(effortChoices(catalog, 'codex')?.map((option) => option.id)).toEqual(['low', 'high'])
  })

  it('offers nothing for a provider with no levels, and is absent for an old desktop', () => {
    expect(effortChoices(catalog, 'claude')).toEqual([])
    expect(effortChoices(catalog, 'opencode')).toBeNull()
    expect(effortChoices(null, 'codex')).toBeNull()
  })

  it('names the saved level, else the one the agent is using, else the first', () => {
    const options = effortChoices(catalog, 'codex') ?? []
    expect(effortLabel(options, 'low')).toBe('Low')
    expect(effortLabel(options, null)).toBe('High')
    expect(effortLabel([{ id: 'a', label: 'A' }], null)).toBe('A')
  })

  it('calls a saved level the provider no longer lists the default', () => {
    expect(effortLabel(effortChoices(catalog, 'codex') ?? [], 'ludicrous')).toBe('Default')
  })
})

describe('permission mode choices', () => {
  it('uses the provider names where it has them and Ari names for the rest', () => {
    expect(modeChoices(catalog, 'codex')).toEqual([
      { value: 'ask', label: 'Read only', description: 'Confirm every edit and command' },
      {
        value: 'allow-edits',
        label: 'Edits',
        description: 'Auto-approve edits; ask before commands',
      },
      { value: 'full', label: 'YOLO', description: 'No approvals' },
    ])
  })

  it('offers Ari names when the provider reports none', () => {
    expect(modeChoices(catalog, 'claude')?.map((option) => option.label)).toEqual([
      'Ask',
      'Edits',
      'Full auto',
    ])
  })

  it('is absent for a desktop that cannot accept a mode from a phone', () => {
    expect(modeChoices(catalog, 'opencode')).toBeNull()
  })

  it('names the current mode', () => {
    expect(modeLabel(modeChoices(catalog, 'codex') ?? [], 'full')).toBe('YOLO')
    expect(modeLabel([], 'allow-edits')).toBe('Edits')
  })
})

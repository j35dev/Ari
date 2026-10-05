import { describe, expect, it } from 'vitest'
import { driverKindSchema, type DriverKind } from '@ari/contracts/common'
import { remoteModelCatalogSchema } from '@ari/contracts/remote'
import { remoteCatalogDefaults, remoteCatalogProviders } from './remote-catalog'

const endpoint = {
  id: 'local',
  name: 'Local model',
  model: 'model:latest',
  models: [
    { id: 'model:latest', label: 'Latest', contextWindow: 32000, source: 'manual' as const },
    { id: 'other', label: 'Other', contextWindow: null, source: 'manual' as const },
  ],
  apiKeyCipher: 'never-share-this-secret',
  baseUrl: 'https://private-endpoint.example',
  headers: { Authorization: 'secret' },
}
function inputs() {
  return {
    detections: driverKindSchema.options.map((kind) => ({
      kind,
      installed: true,
      authStatus: 'unknown',
    })),
    registered: () => true,
    models: (kind: DriverKind) => [
      {
        id: `${kind}-current`,
        label: 'Current',
        aliases: ['native-alias'],
        contextHint: '200k',
        isLegacy: false,
      },
    ],
    source: () => 'live' as const,
    efforts: () => ({ currentId: null, options: [] }),
    modes: () => ({ currentId: null, options: [] }),
    endpoints: [endpoint],
  }
}

describe('authoritative remote provider catalogs', () => {
  it('lists the effort levels and classifiable modes each provider reports', () => {
    const providers = remoteCatalogProviders({
      ...inputs(),
      efforts: (kind) =>
        kind === 'codex'
          ? {
              currentId: 'high',
              options: [
                { id: 'low', label: 'Low' },
                { id: 'high', label: 'High', description: 'Thinks longer' },
              ],
            }
          : { currentId: null, options: [] },
      modes: (kind) =>
        kind === 'codex'
          ? {
              currentId: 'plan',
              options: [
                { id: 'plan', label: 'Plan', ariMode: 'ask' },
                { id: 'mystery', label: 'Mystery', ariMode: null },
              ],
            }
          : { currentId: null, options: [] },
    })
    const codex = providers.find((provider) => provider.driverKind === 'codex')
    expect(codex?.efforts).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High', description: 'Thinks longer', current: true },
    ])
    expect(codex?.modes).toEqual([{ id: 'plan', label: 'Plan', ariMode: 'ask', current: true }])
    expect(providers.find((provider) => provider.driverKind === 'claude')?.efforts).toEqual([])
    expect(remoteModelCatalogSchema.safeParse({ providers }).success).toBe(true)
  })

  it('projects every desktop provider, native model metadata and endpoint defaults without secrets', () => {
    const providers = remoteCatalogProviders(inputs())
    expect(providers.map((provider) => provider.driverKind)).toEqual(driverKindSchema.options)
    for (const provider of providers.filter((row) => row.driverKind !== 'ari-core')) {
      expect(provider).toMatchObject({
        installed: true,
        available: true,
        authStatus: 'unknown',
        source: 'live',
        defaultModelId: null,
        models: [
          {
            id: `${provider.driverKind}-current`,
            aliases: ['native-alias'],
            contextHint: '200k',
            isLegacy: false,
          },
        ],
      })
    }
    expect(providers.at(-1)).toMatchObject({
      driverKind: 'ari-core',
      installed: true,
      available: true,
      defaultModelId: 'ep:local:model:latest',
      models: [
        { id: 'ep:local:model:latest', label: 'Local model · Latest', contextHint: '32k' },
        { id: 'ep:local:other' },
      ],
    })
    const serialized = JSON.stringify(providers)
    expect(serialized).not.toContain('never-share-this-secret')
    expect(serialized).not.toContain('private-endpoint.example')
    expect(serialized).not.toContain('Authorization')
    expect(remoteModelCatalogSchema.safeParse({ providers }).success).toBe(true)
  })

  it.each(driverKindSchema.options.filter((kind) => kind !== 'ari-core'))(
    'keeps %s unavailable when absent, unregistered or logged out and accepts unknown auth',
    (kind) => {
      for (const state of ['absent', 'preparing', 'logged-out', 'unknown', 'authenticated']) {
        const deps = inputs()
        deps.detections = deps.detections.map((row) =>
          row.kind === kind
            ? {
                ...row,
                installed: state !== 'absent',
                authStatus:
                  state === 'logged-out'
                    ? 'unauthenticated'
                    : state === 'authenticated'
                      ? 'authenticated'
                      : 'unknown',
              }
            : row,
        )
        const rows = remoteCatalogProviders({
          ...deps,
          registered: (driver) => driver !== kind || state !== 'preparing',
        })
        const provider = rows.find((row) => row.driverKind === kind)
        expect(provider?.available).toBe(state === 'unknown' || state === 'authenticated')
        expect(provider?.reason === null).toBe(provider?.available)
      }
    },
  )

  it('derives configured, automatic CLI and endpoint-only defaults and does not offer an unconfigured endpoint runtime', () => {
    const providers = remoteCatalogProviders(inputs())
    expect(remoteCatalogDefaults(providers, 'opencode', 'allow-edits')).toEqual({
      driverKind: 'opencode',
      configuredDriverKind: 'opencode',
      modelId: null,
      permissionMode: 'allow-edits',
    })
    expect(remoteCatalogDefaults(providers, null, 'ask').driverKind).toBe('claude')
    expect(
      remoteCatalogDefaults(
        providers.map((row) => ({ ...row, available: row.driverKind === 'ari-core' })),
        'opencode',
        'ask',
      ),
    ).toMatchObject({
      driverKind: 'ari-core',
      modelId: 'ep:local:model:latest',
      configuredDriverKind: 'opencode',
    })
    const empty = remoteCatalogProviders({
      ...inputs(),
      endpoints: [],
      registered: (kind) => kind === 'ari-core',
    })
    expect(empty.at(-1)).toMatchObject({
      available: false,
      installed: true,
      reason: 'Add a model endpoint in desktop settings.',
    })
    expect(remoteCatalogDefaults(empty, null, 'ask').driverKind).toBeNull()
  })
})

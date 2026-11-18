import { describe, expect, it } from 'vitest'
import { driverKindSchema } from './common'
import {
  cliKindSchema,
  defaultSettings,
  providerConnectionsSchema,
  settingsSchema,
  settingsUpdateSchema,
} from './settings'

const PRIMARY = ['claude', 'codex', 'opencode', 'grok'] as const
const OPTIONAL = ['pi', 'hermes', 'qoder', 'muse', 'deepseek'] as const

describe('provider preferences', () => {
  it('enables only the four primary CLIs for a fresh settings file', () => {
    const parsed = settingsSchema.parse({ version: 1 })
    expect(Object.keys(parsed.providers)).toEqual(cliKindSchema.options)
    expect(
      Object.entries(parsed.providers)
        .filter(([, connection]) => connection.enabled)
        .map(([kind]) => kind),
    ).toEqual(PRIMARY)
    expect(parsed.providers).toEqual(defaultSettings.providers)
    expect(parsed.sessions.defaultDriverKind).toBeNull()
    // Ari Core endpoints live in their own user-added connection store.
    expect(parsed.providers).not.toHaveProperty('ari-core')
  })

  it.each(OPTIONAL)(
    'defaults a missing %s enabled field to off while keeping its connection',
    (kind) => {
      const parsed = providerConnectionsSchema.parse({
        [kind]: {
          binaryPath: '/tools/agent',
          accounts: [{ id: 'work', label: 'Work' }],
          activeAccount: 'work',
        },
      })
      expect(parsed[kind]).toEqual({
        enabled: false,
        binaryPath: '/tools/agent',
        accounts: [{ id: 'work', label: 'Work' }],
        activeAccount: 'work',
      })
    },
  )

  it.each(cliKindSchema.options)(
    'preserves explicit enable and disable preferences for %s after saving',
    (kind) => {
      for (const enabled of [true, false]) {
        const saved = settingsSchema.parse({
          version: 1,
          providers: { [kind]: { enabled, binaryPath: '/saved/agent' } },
        })
        const loaded = settingsSchema.parse(JSON.parse(JSON.stringify(saved)))
        expect(loaded.providers[kind].enabled).toBe(enabled)
        expect(loaded.providers[kind].binaryPath).toBe('/saved/agent')
      }
    },
  )

  it('migrates older choices without opting existing Pi or Hermes users out', () => {
    const migrated = settingsSchema.parse({
      version: 1,
      providers: { codex: { enabled: false }, pi: { enabled: true }, hermes: { enabled: true } },
      sessions: { defaultDriverKind: 'pi' },
    })
    expect(migrated.providers.codex.enabled).toBe(false)
    expect(migrated.providers.pi.enabled).toBe(true)
    expect(migrated.providers.hermes.enabled).toBe(true)
    for (const kind of ['qoder', 'muse', 'deepseek'] as const)
      expect(migrated.providers[kind].enabled).toBe(false)
    expect(migrated.sessions.defaultDriverKind).toBe('pi')
  })

  it.each(OPTIONAL)(
    'accepts a scoped %s enable patch without supplying defaults for other providers',
    (kind) => {
      expect(settingsUpdateSchema.parse({ providers: { [kind]: { enabled: true } } })).toEqual({
        providers: { [kind]: { enabled: true } },
      })
      expect(driverKindSchema.parse(kind)).toBe(kind)
      expect(
        settingsSchema.parse({ version: 1, sessions: { defaultDriverKind: kind } }).sessions
          .defaultDriverKind,
      ).toBe(kind)
    },
  )

  it('rejects malformed saved enable preferences rather than silently changing them', () => {
    expect(providerConnectionsSchema.safeParse({ muse: { enabled: 'false' } }).success).toBe(false)
  })
})

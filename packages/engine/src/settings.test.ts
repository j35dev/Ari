import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('persists delegation patches without resetting other limits', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    await store.update({ delegation: { maxConcurrentChildren: 2 } })
    await store.update({ delegation: { recursiveDelegation: true } })
    const reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.delegation).toMatchObject({
      maxConcurrentChildren: 2,
      maxChildrenPerSession: 8,
      recursiveDelegation: true,
      defaultWorkspaceMode: 'isolated',
    })
  })

  it('changes one field of one provider and leaves every other connection alone', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    await store.update({ providers: { claude: { binaryPath: '  /opt/tools/claude ' } } })
    await store.update({ providers: { claude: { enabled: false }, codex: { enabled: false } } })
    const reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.providers.claude).toEqual({ enabled: false, binaryPath: '/opt/tools/claude' })
    expect(reloaded.providers.codex).toEqual({ enabled: false, binaryPath: '' })
    expect(reloaded.providers.grok).toEqual({ enabled: true, binaryPath: '' })
  })

  it('keeps every one of several updates made at the same moment', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    await Promise.all([
      store.update({ providers: { hermes: { enabled: false } } }),
      store.update({ providers: { opencode: { enabled: false } } }),
      store.update({ notifications: { settleSound: false } }),
    ])
    const reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.providers.hermes.enabled).toBe(false)
    expect(reloaded.providers.opencode.enabled).toBe(false)
    expect(reloaded.notifications.settleSound).toBe(false)
    expect(store.current).toEqual(reloaded)
  })

  it('does not let a reload that overlaps a save bring the old settings back', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    const saved = store.update({ providers: { grok: { enabled: false } } })
    const reloaded = store.load()
    await Promise.all([saved, reloaded])
    expect(store.current.providers.grok.enabled).toBe(false)
    await store.update({ notifications: { settleSound: false } })
    expect((await new SettingsStore({ dir }).load()).providers.grok.enabled).toBe(false)
  })

  it('reads a settings file written before providers existed as all on', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, notifications: { settleSound: false } }),
      'utf8',
    )
    const loaded = await new SettingsStore({ dir }).load()
    expect(loaded.notifications.settleSound).toBe(false)
    expect(Object.values(loaded.providers).every((c) => c.enabled && c.binaryPath === '')).toBe(true)
    expect(Object.keys(loaded.providers).sort()).toEqual(
      ['claude', 'codex', 'grok', 'hermes', 'opencode', 'pi'],
    )
  })

  it('creates defaults on first load', async () => {
    const store = new SettingsStore({ dir })
    const settings = await store.load()
    expect(settings.appearance.themeId).toBe('obsidian')
    expect(settings.appearance.mode).toBe('system')
    expect(settings.appearance).not.toHaveProperty('glass')
    expect(settings.sessions.defaultPermissionMode).toBe('ask')
    const raw: unknown = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect((raw as { version: number }).version).toBe(1)
  })

  it('updates sections with merge semantics and persists atomically', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    const next = await store.update({ appearance: { themeId: 'nocturne', mode: 'nocturne' } })
    expect(next.appearance.themeId).toBe('nocturne')
    expect(next.appearance.reducedMotion).toBe(false)
    expect(store.current.appearance.themeId).toBe('nocturne')

    const reloaded = new SettingsStore({ dir })
    const persisted = await reloaded.load()
    expect(persisted.appearance.themeId).toBe('nocturne')
    expect(persisted.appearance.mode).toBe('nocturne')
  })

  it('merges notification patches and defaults the settle sound for old files', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    expect(store.current.notifications.settleSound).toBe(true)
    const next = await store.update({ notifications: { settleSound: false } })
    expect(next.notifications.settleSound).toBe(false)
    expect(next.appearance.themeId).toBe('obsidian') // untouched section survives

    const persisted = await new SettingsStore({ dir }).load()
    expect(persisted.notifications.settleSound).toBe(false)
  })

  it('falls back to defaults on corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'settings.json'), '{corrupt', 'utf8')
    const store = new SettingsStore({ dir })
    const settings = await store.load()
    expect(settings).toEqual(await new SettingsStore({ dir }).load())
    expect(settings.appearance.themeId).toBe('obsidian')
  })

  it('migrates the pre-M16 single-appearance themeId to the default theme', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        appearance: { themeId: 'comet-glass', glass: false, reducedMotion: true },
      }),
      'utf8',
    )
    const settings = await new SettingsStore({ dir }).load()
    expect(settings.appearance.themeId).toBe('obsidian')
    expect(settings.appearance.reducedMotion).toBe(true)
    expect(settings.appearance).not.toHaveProperty('glass')
  })

  it('drops unknown fields via schema validation', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        appearance: { themeId: 'verdant', evilField: true },
        bogus: 'x',
      }),
      'utf8',
    )
    const store = new SettingsStore({ dir })
    const settings = await store.load()
    expect(settings.appearance.themeId).toBe('verdant')
    expect(JSON.stringify(settings)).not.toContain('bogus')
  })
})

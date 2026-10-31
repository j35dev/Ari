import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  it('persists first-run completion across unrelated updates and rejects invalid markers', async () => {
    const store = new SettingsStore({ dir })
    expect((await store.load()).onboarding).toBeUndefined()
    await store.update({ onboarding: { completedAt: 1234 } })
    await store.update({ appearance: { reducedMotion: true } })
    expect((await new SettingsStore({ dir }).load()).onboarding?.completedAt).toBe(1234)
    await expect(store.update({ onboarding: { completedAt: -1 } })).rejects.toThrow()
    expect(store.current.onboarding?.completedAt).toBe(1234)
  })
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
    expect(reloaded.providers.claude).toMatchObject({
      enabled: false,
      binaryPath: '/opt/tools/claude',
    })
    expect(reloaded.providers.codex).toMatchObject({ enabled: false, binaryPath: '' })
    expect(reloaded.providers.grok).toMatchObject({ enabled: true, binaryPath: '' })
  })

  it('stores a provider’s accounts and never leaves a removed one in use', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    await store.update({
      providers: {
        claude: { accounts: [{ id: 'work', label: 'Work' }], activeAccount: 'work' },
      },
    })
    await store.update({ providers: { claude: { binaryPath: '/opt/claude' } } })
    let reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.providers.claude).toEqual({
      enabled: true,
      binaryPath: '/opt/claude',
      accounts: [{ id: 'work', label: 'Work' }],
      activeAccount: 'work',
    })
    expect(reloaded.providers.codex.activeAccount).toBe('default')

    await store.update({ providers: { claude: { accounts: [] } } })
    reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.providers.claude.activeAccount).toBe('default')
  })

  it('refuses an account whose id could not name a folder', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    for (const id of ['../escape', 'Work', 'default', '']) {
      await expect(
        store.update({ providers: { claude: { accounts: [{ id, label: 'x' }] } } }),
      ).rejects.toThrow()
    }
    expect(store.current.providers.claude.accounts).toEqual([])
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
    expect(Object.values(loaded.providers).every((c) => c.enabled && c.binaryPath === '')).toBe(
      true,
    )
    expect(Object.keys(loaded.providers).sort()).toEqual([
      'claude',
      'codex',
      'grok',
      'hermes',
      'opencode',
      'pi',
    ])
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

  it('keeps the Hive view choice across a reload', async () => {
    const store = new SettingsStore({ dir })
    expect((await store.load()).appearance.hiveView).toBeUndefined()
    await store.update({ appearance: { hiveView: true } })

    const persisted = await new SettingsStore({ dir }).load()
    expect(persisted.appearance.hiveView).toBe(true)
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

  it.each(['{corrupt', '{"version":99}'])(
    'preserves invalid settings and refuses automatic writes: %s',
    async (raw) => {
      const { writeFile } = await import('node:fs/promises')
      const path = join(dir, 'settings.json')
      const store = new SettingsStore({ dir })
      await store.load()
      await writeFile(path, raw, 'utf8')
      await expect(store.load()).rejects.toThrow()
      await expect(store.update({ onboarding: { completedAt: 1 } })).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(raw)
      await writeFile(
        path,
        JSON.stringify({ version: 1, sessions: { defaultDriverKind: 'codex' } }),
      )
      expect((await store.load()).sessions.defaultDriverKind).toBe('codex')
      await store.update({ onboarding: { completedAt: 2 } })
      expect((await new SettingsStore({ dir }).load()).onboarding?.completedAt).toBe(2)
    },
  )

  it('does not mistake an unreadable settings path for a missing file', async () => {
    await mkdir(join(dir, 'settings.json'))
    const store = new SettingsStore({ dir })
    await expect(store.load()).rejects.toThrow()
    await expect(store.update({ notifications: { settleSound: false } })).rejects.toThrow()
    await rm(join(dir, 'settings.json'), { recursive: true })
    expect((await store.load()).version).toBe(1)
  })

  it('reads saved preferences before accepting a window update at boot', async () => {
    const saved = new SettingsStore({ dir })
    await saved.update({ providers: { claude: { enabled: false } } })
    const cold = new SettingsStore({ dir })
    await cold.update({ window: { x: 0, y: 0, width: 1280, height: 800, maximized: false } })
    expect(cold.current.providers.claude.enabled).toBe(false)
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

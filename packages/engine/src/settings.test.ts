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
  it('creates defaults on first load', async () => {
    const store = new SettingsStore({ dir })
    const settings = await store.load()
    expect(settings.appearance.themeId).toBe('comet-glass')
    expect(settings.sessions.defaultPermissionMode).toBe('ask')
    const raw: unknown = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect((raw as { version: number }).version).toBe(1)
  })

  it('updates sections with merge semantics and persists atomically', async () => {
    const store = new SettingsStore({ dir })
    await store.load()
    const next = await store.update({ appearance: { themeId: 'ember' } })
    expect(next.appearance.themeId).toBe('ember')
    expect(next.appearance.reducedMotion).toBe(false)
    expect(store.current.appearance.themeId).toBe('ember')

    const reloaded = new SettingsStore({ dir })
    const persisted = await reloaded.load()
    expect(persisted.appearance.themeId).toBe('ember')
  })

  it('falls back to defaults on corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'settings.json'), '{corrupt', 'utf8')
    const store = new SettingsStore({ dir })
    const settings = await store.load()
    expect(settings).toEqual(await new SettingsStore({ dir }).load())
    expect(settings.appearance.themeId).toBe('comet-glass')
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

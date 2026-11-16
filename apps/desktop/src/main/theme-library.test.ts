// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { neonThemeExample } from '@ari/contracts/themes'
import { SettingsStore } from '@ari/engine/settings'
import { ThemeLibrary } from './theme-library'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ari-theme-'))
  dirs.push(dir)
  const settings = new SettingsStore({ dir })
  await settings.load()
  const publish = vi.fn()
  return { dir, settings, publish, library: new ThemeLibrary(settings, publish) }
}
it('serializes simultaneous installs without losing themes or unrelated settings', async () => {
  const { dir, settings, library } = await setup()
  await settings.update({
    appearance: { mode: 'porcelain', themeId: 'porcelain' },
    notifications: { desktop: false },
  })
  await Promise.all([
    library.install(neonThemeExample, true),
    library.install({ ...neonThemeExample, id: 'custom:second', name: 'Second' }),
  ])
  const loaded = await new SettingsStore({ dir }).load()
  expect(loaded.appearance.customThemes).toHaveLength(2)
  expect(loaded.appearance.mode).toBe('porcelain')
  expect(loaded.notifications.desktop).toBe(false)
})
it('rejects unsafe themes without writing or publishing, and keeps the active revision during edits', async () => {
  const { settings, publish, library } = await setup()
  expect(() => library.install({ ...neonThemeExample, css: 'body{display:none}' })).toThrow()
  expect(publish).not.toHaveBeenCalled()
  await library.install(neonThemeExample)
  await settings.update({
    appearance: {
      mode: neonThemeExample.id,
      themeId: neonThemeExample.id,
      activeCustomTheme: neonThemeExample,
    },
  })
  await library.install({ ...neonThemeExample, name: 'New revision' }, true)
  expect(settings.current.appearance.activeCustomTheme?.name).toBe('Neon circuit')
  expect(library.list().themes).toHaveLength(1)
  expect(library.schema().schema).toHaveProperty('properties')
  await library.remove(neonThemeExample.id)
  expect(settings.current.appearance.mode).toBe('obsidian')
  expect(settings.current.appearance.activeCustomTheme).toBeNull()
})

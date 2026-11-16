// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { neonThemeExample } from '@ari/contracts/themes'
import { SettingsStore } from '@ari/engine/settings'
import { ThemeLibrary } from './theme-library'
import { ThemeAssetStore } from './theme-assets'

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
  await expect(
    library.install({ ...neonThemeExample, css: 'body{background:url(https://example.com/x)}' }),
  ).rejects.toThrow()
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
  expect(library.schema().guide).toContain('ari theme screenshot')
  expect(library.schema().hooks).toHaveProperty('brand')
  await library.remove(neonThemeExample.id)
  expect(settings.current.appearance.mode).toBe('obsidian')
  expect(settings.current.appearance.activeCustomTheme).toBeNull()
})

it('stores theme files with the theme and saves window screenshots', async () => {
  const { dir, settings, publish } = await setup()
  const folder = join(dir, 'one-piece')
  await mkdir(folder)
  await writeFile(
    join(folder, 'wallpaper.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
  )
  const capture = vi.fn(async () => ({ png: Buffer.from('png'), width: 4, height: 3 }))
  const library = new ThemeLibrary(
    settings,
    publish,
    new ThemeAssetStore(join(dir, 'assets')),
    capture,
  )
  const theme = {
    ...neonThemeExample,
    assets: [{ name: 'wallpaper.png' }],
    wallpaper: { asset: 'wallpaper.png', blur: 0, tint: 50, position: 'center' as const },
  }
  await expect(library.install(theme)).rejects.toThrow(/not found/)
  const event = await library.install(theme, true, { assetsDir: folder })
  expect(event.themes[0]?.assets?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect((await library.exportTheme(theme.id)).assetData).not.toEqual({})
  await library.remove(theme.id)
  expect(await readdir(join(dir, 'assets'))).toEqual([])

  const out = join(dir, 'shots', 'theme.png')
  expect(await library.screenshot(out)).toEqual({ path: out, width: 4, height: 3 })
  expect(await readFile(out, 'utf8')).toBe('png')
  await expect(library.screenshot('relative.png')).rejects.toThrow(/absolute/)
})

it('refuses themes that box every row, paragraph or tool line', async () => {
  const { publish, library } = await setup()
  const boxed = {
    ...neonThemeExample,
    parts: {
      button: { default: { borderWidth: 1, borderColor: '#2c3348', backgroundColor: '#1b1f2e' } },
      'list-row': { hover: { backgroundColor: '#1b1f2e' } },
    },
  }
  await expect(library.validate(boxed)).rejects.toThrow(/parts\.button\.default: remove/)
  await expect(library.install(boxed)).rejects.toThrow(/box the whole app/)
  expect(publish).not.toHaveBeenCalled()
  const calm = { ...boxed, parts: { 'list-row': boxed.parts['list-row'] } }
  await expect(library.validate(calm)).resolves.toMatchObject({ valid: true })
})

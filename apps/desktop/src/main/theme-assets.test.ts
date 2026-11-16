// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { neonThemeExample, type CustomTheme } from '@ari/contracts/themes'
import { ThemeAssetStore, sniffThemeAsset } from './theme-assets'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'ari-theme-assets-'))
  dirs.push(dir)
  return dir
}
const theme = (names: string[]): CustomTheme => ({
  ...neonThemeExample,
  assets: names.map((name) => ({ name })),
})

it('checks that files are the type their name claims', () => {
  expect(sniffThemeAsset(PNG, 'png')).toBe(true)
  expect(sniffThemeAsset(PNG, 'jpg')).toBe(false)
  expect(sniffThemeAsset(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'), 'svg')).toBe(
    true,
  )
  expect(sniffThemeAsset(Buffer.from('<html><script>alert(1)</script>'), 'svg')).toBe(false)
})

it('stores files by hash, keeps them across revisions and removes unreferenced ones', async () => {
  const folder = await temp()
  const store = new ThemeAssetStore(join(await temp(), 'store'))
  await writeFile(join(folder, 'wallpaper.png'), PNG)

  await expect(store.collect(theme(['wallpaper.png']), { write: false })).rejects.toThrow(
    /not found/,
  )
  const checked = await store.collect(theme(['wallpaper.png']), { assetsDir: folder, write: false })
  expect(await readdir(store.dir).catch(() => [])).toEqual([])

  const stored = await store.collect(theme(['wallpaper.png']), { assetsDir: folder, write: true })
  expect(stored.assets?.[0]?.sha256).toBe(checked.assets?.[0]?.sha256)
  expect(await readdir(store.dir)).toEqual([`${stored.assets![0]!.sha256}.png`])

  // A revision authored without the file reuses what the previous revision stored.
  const revision = await store.collect(theme(['wallpaper.png']), {
    assetsDir: await temp(),
    previous: stored,
    write: true,
  })
  expect(revision.assets).toEqual(stored.assets)

  const data = await store.exportData(stored)
  const imported = new ThemeAssetStore(join(await temp(), 'other'))
  expect(
    (await imported.collect(stored, { assetData: data, write: true })).assets?.[0]?.sha256,
  ).toBe(stored.assets?.[0]?.sha256)

  await store.collectGarbage([neonThemeExample])
  expect(await readdir(store.dir)).toEqual([])
})

it('refuses a file that is not really an image', async () => {
  const folder = await temp()
  await writeFile(join(folder, 'wallpaper.jpg'), '<html>not a picture</html>')
  const store = new ThemeAssetStore(join(await temp(), 'store'))
  await expect(
    store.collect(theme(['wallpaper.jpg']), { assetsDir: folder, write: true }),
  ).rejects.toThrow(/not a valid \.jpg/)
  expect(store.resolve('../../secret.png')).toBeNull()
  expect(store.resolve(`${'a'.repeat(64)}.png`)).toBe(join(store.dir, `${'a'.repeat(64)}.png`))
})

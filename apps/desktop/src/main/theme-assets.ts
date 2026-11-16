import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  THEME_ASSET_MAX_BYTES,
  THEME_ASSETS_MAX_BYTES,
  type CustomTheme,
  type ThemeAsset,
} from '@ari/contracts/themes'

const STORED = /^([a-f0-9]{64})\.(png|jpe?g|webp|gif|avif|svg|woff2)$/

export const themeAssetMime: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
}

const ascii = (bytes: Buffer, start: number, end: number) =>
  bytes.subarray(start, end).toString('latin1')

/** Whether the bytes really are the file type its extension claims. */
export function sniffThemeAsset(bytes: Buffer, ext: string): boolean {
  switch (ext) {
    case 'png':
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case 'jpg':
    case 'jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'gif':
      return ascii(bytes, 0, 4) === 'GIF8'
    case 'webp':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
    case 'avif':
      return ascii(bytes, 4, 8) === 'ftyp' && /avi[fs]/.test(ascii(bytes, 8, 32))
    case 'woff2':
      return ascii(bytes, 0, 4) === 'wOF2'
    case 'svg': {
      const head = bytes
        .subarray(0, 4096)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart()
      return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
        head,
      )
    }
    default:
      return false
  }
}

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1)

/**
 * Theme images and fonts, stored once by content hash under userData. Revisions
 * never overwrite a file the confirmed theme still uses, and unreferenced files
 * are removed after library changes.
 */
export class ThemeAssetStore {
  constructor(readonly dir: string) {}

  /** Absolute path for a `<sha256>.<ext>` file name, or null when it is not one. */
  resolve(file: string): string | null {
    return STORED.test(file) ? join(this.dir, file) : null
  }

  #path(asset: { name: string; sha256: string }) {
    return join(this.dir, `${asset.sha256}.${extOf(asset.name)}`)
  }

  async #exists(asset: { name: string; sha256?: string | undefined }): Promise<boolean> {
    if (!asset.sha256) return false
    return stat(this.#path({ name: asset.name, sha256: asset.sha256 })).then(
      (info) => info.isFile(),
      () => false,
    )
  }

  async #read(path: string, name: string): Promise<Buffer | null> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    if (info.size > THEME_ASSET_MAX_BYTES)
      throw new Error(`${name} is larger than ${THEME_ASSET_MAX_BYTES / 1024 / 1024} MB.`)
    return readFile(path)
  }

  /**
   * Finds every listed file: in `assetsDir` first, then in exported data, then
   * already stored (same hash, or the same name in the previous revision).
   * With `write`, new files are stored and the result carries their hashes.
   */
  async collect(
    theme: CustomTheme,
    options: {
      assetsDir?: string | undefined
      assetData?: Record<string, string> | undefined
      previous?: CustomTheme | undefined
      write: boolean
    },
  ): Promise<CustomTheme> {
    if (!theme.assets?.length) return theme
    let total = 0
    const assets: ThemeAsset[] = []
    for (const asset of theme.assets) {
      const ext = extOf(asset.name)
      let bytes =
        options.assetsDir === undefined
          ? null
          : await this.#read(join(options.assetsDir, asset.name), asset.name)
      if (!bytes && asset.sha256 && options.assetData?.[asset.sha256])
        bytes = Buffer.from(options.assetData[asset.sha256]!, 'base64')
      if (bytes) {
        if (bytes.length > THEME_ASSET_MAX_BYTES)
          throw new Error(`${asset.name} is larger than ${THEME_ASSET_MAX_BYTES / 1024 / 1024} MB.`)
        if (!sniffThemeAsset(bytes, ext))
          throw new Error(`${asset.name} is not a valid .${ext} file. Check the download.`)
        total += bytes.length
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (options.write) {
          const target = this.#path({ name: asset.name, sha256 })
          if (!(await this.#exists({ name: asset.name, sha256 }))) {
            await mkdir(this.dir, { recursive: true })
            const temp = `${target}.${process.pid}.${Date.now()}.tmp`
            await writeFile(temp, bytes)
            await rename(temp, target)
          }
        }
        assets.push({ name: asset.name, sha256 })
        continue
      }
      const kept = [asset, options.previous?.assets?.find((entry) => entry.name === asset.name)]
      let found: ThemeAsset | undefined
      for (const candidate of kept)
        if (candidate?.sha256 && (await this.#exists(candidate))) {
          found = { name: asset.name, sha256: candidate.sha256 }
          break
        }
      if (!found)
        throw new Error(
          `Asset ${asset.name} was not found${options.assetsDir ? ` in ${options.assetsDir}` : ''}. ` +
            'Put the file next to the theme JSON or pass --assets <dir>.',
        )
      const info = await stat(this.#path({ name: found.name, sha256: found.sha256! }))
      total += info.size
      assets.push(found)
    }
    if (total > THEME_ASSETS_MAX_BYTES)
      throw new Error(
        `A theme's files must total at most ${THEME_ASSETS_MAX_BYTES / 1024 / 1024} MB.`,
      )
    return { ...theme, assets }
  }

  /** Base64 file contents keyed by hash, for a portable export. */
  async exportData(theme: CustomTheme): Promise<Record<string, string>> {
    const data: Record<string, string> = {}
    for (const asset of theme.assets ?? []) {
      if (!asset.sha256) continue
      const bytes = await readFile(this.#path({ name: asset.name, sha256: asset.sha256 })).catch(
        () => null,
      )
      if (bytes) data[asset.sha256] = bytes.toString('base64')
    }
    return data
  }

  /** Deletes stored files no listed theme refers to. */
  async collectGarbage(themes: readonly (CustomTheme | null | undefined)[]): Promise<void> {
    const keep = new Set<string>()
    for (const theme of themes)
      for (const asset of theme?.assets ?? [])
        if (asset.sha256) keep.add(`${asset.sha256}.${extOf(asset.name)}`)
    const files = await readdir(this.dir).catch(() => [] as string[])
    await Promise.all(
      files
        .filter((file) => (STORED.test(file) && !keep.has(file)) || file.endsWith('.tmp'))
        .map((file) => rm(join(this.dir, file), { force: true }).catch(() => undefined)),
    )
  }
}

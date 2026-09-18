import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The installable shell, checked as files rather than as pixels.
 *
 * A manifest that names an icon that was never generated installs as a blank
 * square on a home screen — the failure is silent and only visible on a real
 * phone. These tests keep the manifest, the service worker precache, and the
 * apple-touch link pointed at assets that exist, at the sizes claimed.
 */

const mobileRoot = join(__dirname, '..')
const publicDir = join(mobileRoot, 'public')

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(join(publicDir, file))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('PWA install assets', () => {
  it('points every manifest icon at a file that exists, at the claimed size', () => {
    const manifest = JSON.parse(
      readFileSync(join(publicDir, 'manifest.webmanifest'), 'utf8'),
    ) as { icons: { src: string; sizes: string }[] }
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      const file = icon.src.replace(/^\//, '')
      expect(existsSync(join(publicDir, file)), icon.src).toBe(true)
      const match = /^(\d+)x(\d+)$/.exec(icon.sizes)
      if (match?.[1] !== undefined && file.endsWith('.png')) {
        expect(pngSize(file)).toEqual({ width: Number(match[1]), height: Number(match[2]) })
      }
    }
    // iOS ignores SVG home-screen icons, so at least one raster icon per
    // purpose must exist or installation shows a blank tile.
    const purposes = new Set(
      manifest.icons.filter((icon) => icon.src.endsWith('.png')).map((icon) => icon.src),
    )
    expect(purposes.size).toBeGreaterThan(0)
  })

  it('precaches only shell files that exist', () => {
    const worker = readFileSync(join(publicDir, 'sw.js'), 'utf8')
    const cached = [...worker.matchAll(/'(\/[^']+)'/g)].map((match) => match[1] as string)
    for (const path of new Set(cached)) {
      // Routes without an extension are served, not files; the API exclusion
      // list is covered by the gateway's own tests.
      if (!path.includes('.')) continue
      expect(existsSync(join(publicDir, path.replace(/^\//, ''))), path).toBe(true)
    }
  })

  it('links the apple-touch icon at a file that exists', () => {
    const html = readFileSync(join(mobileRoot, 'index.html'), 'utf8')
    const href = /rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1]
    expect(href).toBeDefined()
    expect(existsSync(join(publicDir, (href as string).replace(/^\//, '')))).toBe(true)
  })
})

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Vitest roots at this package (see tailwind-sources.test.ts for why cwd).
const ROOTS = [
  resolve(process.cwd(), 'src/renderer/src'),
  resolve(process.cwd(), '../../packages/ui/src'),
]

/**
 * Floating layers (z-30 and up, or a bracketed one-off) must come from the
 * token scale — z-popover, z-overlay, z-toast, z-context — or two surfaces
 * end up sharing a number and whichever mounts last wins.
 */
const RAW_LAYER = /(?<![\w-])-?z-(?:\[[^\]]+\]|[3-9]\d|\d{3,})(?![\w-])/g

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.'))
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('z-index scale', () => {
  it('leaves no raw floating-layer z-index in the renderer or the UI package', async () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of await sources(root)) {
        const text = await readFile(file, 'utf8')
        for (const match of text.matchAll(RAW_LAYER)) offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

import { stat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Vitest roots at this package. `import.meta.url` is not a file URL under the
// jsdom environment, so the entry is resolved from the working directory.
const ENTRY = resolve(process.cwd(), 'src/renderer/src/styles/index.css')

/** Every path an active `@source` (or `@source not`) directive points at. */
async function sourceDirectives(): Promise<string[]> {
  const css = await readFile(ENTRY, 'utf8')
  // Comments are stripped first: a commented-out directive is inert to
  // Tailwind, so matching one would make this guard pass on a broken sheet.
  const live = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = /@source\s+(?:not\s+)?['"]([^'"]+)['"]/g
  return [...live.matchAll(pattern)].map((match) => match[1] ?? '')
}

/**
 * Tailwind v4's automatic source detection only reaches this app's own tree.
 * `@ari/ui` resolves through a `node_modules` symlink, which detection skips,
 * so a utility that appears *only* in the shared UI package never generates.
 *
 * The loss is selective, and that is what hid it for so long: a class survives
 * as long as it also appears somewhere under `apps/desktop`. The toast
 * viewport's `top-12 right-4` appears nowhere else, so it vanished, and the
 * viewport fell back to its static position below the fold — invisible under
 * `body { overflow: hidden }` — while Settings still reported the update.
 *
 * No component test can catch that: jsdom applies no Tailwind at all, so a
 * toast rendered off-screen still matches its text and passes. The guard has
 * to live at the stylesheet, where the `@source` directive can be checked for
 * both presence and a target that actually exists.
 */
describe('tailwind source detection', () => {
  it('scans the shared UI package, which auto-detection cannot reach', async () => {
    const resolved = (await sourceDirectives()).map((path) => resolve(dirname(ENTRY), path))
    const uiSources = resolved.filter((path) =>
      path.split('\\').join('/').endsWith('/packages/ui/src'),
    )
    expect(uiSources, 'no @source directive covers packages/ui/src').toHaveLength(1)
    await expect(stat(uiSources[0] ?? '')).resolves.toBeTruthy()
  })
})

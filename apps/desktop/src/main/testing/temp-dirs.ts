import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

/**
 * Creates temp dirs that are removed after each test in the calling file.
 * Call it at module top level, before other afterEach hooks: vitest runs
 * after-hooks in reverse order, so the removal runs after them.
 */
export function useTempDirs(): (prefix: string) => string {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    dirs.length = 0
  })
  return (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
}

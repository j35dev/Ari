import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

/** Creates temp dirs that are removed after every test in the current file. */
export function useTempDirs(): (prefix: string) => Promise<string> {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    dirs.length = 0
  })
  return async (prefix: string) => {
    const dir = await mkdtemp(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
}

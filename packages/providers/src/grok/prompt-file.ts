import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('providers:grok-prompt')
const PREFIX = 'ari-grok-prompt-'
const DAY_MS = 24 * 60 * 60 * 1_000
let initialSweep: Promise<void> | undefined

/** Crashed hosts cannot dispose their files; remove yesterday's remnants at startup. */
export async function sweepGrokPromptFiles(root = tmpdir(), now = Date.now()): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
        .map(async (entry) => {
          const path = join(root, entry.name)
          try {
            if (now - (await stat(path)).mtimeMs > DAY_MS)
              await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
          } catch (error) {
            log.debug('stale prompt cleanup failed', { error: String(error) })
          }
        }),
    )
  } catch (error) {
    log.debug('prompt directory scan failed', { error: String(error) })
  }
}

export interface GrokPromptFile {
  path: string
  dispose(): Promise<void>
}

export async function createGrokPromptFile(prompt: string): Promise<GrokPromptFile> {
  await (initialSweep ??= sweepGrokPromptFiles())
  // mkdtemp uses 0700 on POSIX and inherits the user's private TEMP ACL on Windows.
  const dir = await mkdtemp(join(tmpdir(), PREFIX))
  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    (cleanup ??= rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const path = join(dir, 'prompt.txt')
  try {
    await writeFile(path, prompt, { encoding: 'utf8', mode: 0o600 })
    return { path, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

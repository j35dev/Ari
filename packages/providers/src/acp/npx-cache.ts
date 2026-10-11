import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('providers:acp')

/** npm names the manifest it could not read. */
const MISSING_MANIFEST = /Could not read package\.json: Error: ENOENT[^']*'([^']+)'/

/**
 * The npx install dir npm just failed on, when that dir is half-installed:
 * `node_modules` written, `package.json` never saved. An install killed
 * mid-way leaves exactly that, and npm reads the manifest on every run, with
 * or without `-y`, so the package cannot launch again until the dir is gone.
 * Null for any other failure, and for any path that is not
 * `<npm cache>/_npx/<16 hex>`.
 */
export function brokenNpxInstallDir(stderr: string): string | null {
  const manifest = MISSING_MANIFEST.exec(stderr)?.[1]
  if (manifest === undefined || basename(manifest) !== 'package.json') return null
  const dir = dirname(manifest)
  if (!/^[0-9a-f]{16}$/.test(basename(dir)) || basename(dirname(dir)) !== '_npx') return null
  return existsSync(manifest) ? null : dir
}

/** Clears that dir so the next `npx -y` installs afresh. True when it did. */
export async function removeBrokenNpxInstall(stderr: string): Promise<boolean> {
  const dir = brokenNpxInstallDir(stderr)
  if (dir === null) return false
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    log.warn('acp: could not clear a half-installed npx entry', { dir, error: String(error) })
    return false
  }
  log.warn('acp: cleared a half-installed npx entry', { dir })
  return true
}

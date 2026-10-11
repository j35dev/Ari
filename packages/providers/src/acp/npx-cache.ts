import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('providers:acp')

/** npm names the manifest it could not read. */
const MISSING_MANIFEST = /Could not read package\.json: Error: ENOENT[^']*'([^']+)'/

/** npm touches its install lock every second and calls it stale after five. */
const INSTALL_LOCK_FRESH_MS = 10_000

/**
 * True while another npx is installing into `dir`. An install in progress
 * looks exactly like a broken one — `node_modules` there, `package.json` not
 * yet saved — and a second launch that arrives meanwhile fails with the same
 * error, so the lock is the only thing that tells the two apart.
 */
function installInProgress(dir: string): boolean {
  try {
    return Date.now() - statSync(join(dir, 'concurrency.lock')).mtimeMs < INSTALL_LOCK_FRESH_MS
  } catch {
    return false
  }
}

/**
 * The npx install dir npm just failed on, when that dir is half-installed:
 * `node_modules` written, `package.json` never saved. An install killed
 * mid-way leaves exactly that, and npm reads the manifest on every run, with
 * or without `-y`, so the package cannot launch again until the dir is gone.
 * Null for any other failure, for any path that is not
 * `<npm cache>/_npx/<16 hex>`, and while an install is still writing it.
 */
export function brokenNpxInstallDir(stderr: string): string | null {
  const manifest = MISSING_MANIFEST.exec(stderr)?.[1]
  if (manifest === undefined || basename(manifest) !== 'package.json') return null
  const dir = dirname(manifest)
  if (!/^[0-9a-f]{16}$/.test(basename(dir)) || basename(dirname(dir)) !== '_npx') return null
  if (existsSync(manifest) || installInProgress(dir)) return null
  return dir
}

/** Repairs in flight, so launches that fail together clear the dir once. */
const repairs = new Map<string, Promise<boolean>>()

async function clear(dir: string): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    log.warn('acp: could not clear a half-installed npx entry', { dir, error: String(error) })
    return false
  }
  log.warn('acp: cleared a half-installed npx entry', { dir })
  return true
}

/** Clears that dir so the next `npx -y` installs afresh. True when it did. */
export function removeBrokenNpxInstall(stderr: string): Promise<boolean> {
  const dir = brokenNpxInstallDir(stderr)
  if (dir === null) return Promise.resolve(false)
  const running = repairs.get(dir)
  if (running !== undefined) return running
  const repair = clear(dir).finally(() => repairs.delete(dir))
  repairs.set(dir, repair)
  return repair
}

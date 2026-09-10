import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:music-runtime')

/** Directory inside application data holding the per-user music helper. */
export const MUSIC_RUNTIME_DIRNAME = 'ari-music-runtime'
const STAMP_NAME = '.runtime.json'
const MANIFEST_NAME = 'music-runtime.json'

export interface MusicRuntimeTarget {
  asset: string
  sha256: string
  binary: string
  size: number
}

export interface MusicRuntimeManifest {
  version: string
  baseUrl: string
  targets: Record<string, MusicRuntimeTarget>
}

/** Where the manifest and the user-data cache live. */
export interface MusicRuntimeEnvironment {
  /** True inside the packaged app; defaults to false (development layout). */
  isPackaged?: boolean
  resourcesPath: string
  appPath: string
  userDataPath?: string
}

export type RuntimeProgress = (downloadedBytes: number, totalBytes: number | null) => void

/** Manifest key for this runtime, or null on unsupported platforms. */
export function musicRuntimeTargetKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  if (!normalizedArch) return null
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return null
  return `${platform}-${normalizedArch}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Reads and validates the tiny bundled manifest; null when absent or malformed. */
export async function readMusicRuntimeManifest(
  env: MusicRuntimeEnvironment,
): Promise<MusicRuntimeManifest | null> {
  const root = env.isPackaged === true ? env.resourcesPath : join(env.appPath, 'resources')
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, MANIFEST_NAME), 'utf8'))
    const manifest = asRecord(parsed)
    const version = manifest ? asString(manifest['version']) : null
    const baseUrl = manifest ? asString(manifest['baseUrl']) : null
    const targets = manifest ? asRecord(manifest['targets']) : null
    if (!version || !baseUrl || !targets) return null
    return { version, baseUrl, targets: targets as MusicRuntimeManifest['targets'] }
  } catch {
    return null
  }
}

function targetEntry(
  manifest: MusicRuntimeManifest,
  key: string,
): MusicRuntimeTarget | null {
  const row = asRecord(manifest.targets[key])
  const asset = row ? asString(row['asset']) : null
  const sha256 = row ? asString(row['sha256']) : null
  const binary = row ? asString(row['binary']) : null
  if (!asset || !sha256 || !binary) return null
  const size = row?.['size']
  return {
    asset,
    sha256,
    binary,
    size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function stampMatches(dir: string, entry: MusicRuntimeTarget): Promise<boolean> {
  try {
    const stamp: unknown = JSON.parse(await readFile(join(dir, STAMP_NAME), 'utf8'))
    const row = asRecord(stamp)
    return row?.['sha256'] === entry.sha256 && (await exists(join(dir, entry.binary)))
  } catch {
    return false
  }
}

/**
 * One architecture's music helper, cached per user. The installer ships only
 * the manifest; the ~18–40MB binary downloads on first Focus Music use into
 * application data, verified by SHA-256 before first run. Users never install
 * anything by hand and see only "Preparing Focus Music…" while it fetches.
 */
export class MusicRuntime {
  readonly #env: MusicRuntimeEnvironment
  readonly #fetch: typeof fetch
  #ensuring: Promise<string | null> | null = null

  constructor(env: MusicRuntimeEnvironment, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#env = env
    this.#fetch = fetchImpl
  }

  #cacheDir(key: string): string | null {
    if (!this.#env.userDataPath) return null
    return join(this.#env.userDataPath, MUSIC_RUNTIME_DIRNAME, key)
  }

  /** Cached, verified binary — explicit override first (tests, development). */
  async binaryPath(): Promise<string | null> {
    const override = process.env['ARI_MUSIC_RUNTIME_BIN']?.trim()
    if (override && (await exists(override))) return override
    const key = musicRuntimeTargetKey()
    if (!key) return null
    const manifest = await readMusicRuntimeManifest(this.#env)
    const entry = manifest ? targetEntry(manifest, key) : null
    const dir = this.#cacheDir(key)
    if (!manifest || !entry || !dir) return null
    return (await stampMatches(dir, entry)) ? join(dir, entry.binary) : null
  }

  /** ready | downloading | missing | unavailable (unsupported platform). */
  async status(): Promise<'ready' | 'downloading' | 'missing' | 'unavailable'> {
    if (this.#ensuring) return 'downloading'
    if ((await this.binaryPath()) !== null) return 'ready'
    return musicRuntimeTargetKey() === null ? 'unavailable' : 'missing'
  }

  /**
   * Returns the verified binary, downloading it once on first use. Concurrent
   * callers share one in-flight download; integrity failure returns null.
   */
  async ensure(onProgress?: RuntimeProgress): Promise<string | null> {
    if (this.#ensuring) return this.#ensuring
    const attempt = this.#download(onProgress)
    this.#ensuring = attempt
    try {
      return await attempt
    } finally {
      if (this.#ensuring === attempt) this.#ensuring = null
    }
  }

  async #download(onProgress?: RuntimeProgress): Promise<string | null> {
    const ready = await this.binaryPath()
    if (ready) return ready
    const key = musicRuntimeTargetKey()
    const manifest = await readMusicRuntimeManifest(this.#env)
    const entry = key && manifest ? targetEntry(manifest, key) : null
    const dir = key ? this.#cacheDir(key) : null
    if (!key || !manifest || !entry || !dir) return null
    const dest = join(dir, entry.binary)
    log.info('downloading music helper', { target: key, version: manifest.version })
    try {
      await mkdir(dir, { recursive: true })
      const response = await this.#fetch(`${manifest.baseUrl}/${entry.asset}`)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const chunks: Uint8Array[] = []
      let received = 0
      const total = Number(response.headers.get('content-length')) || entry.size || null
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          received += value.byteLength
          onProgress?.(received, total)
        }
      }
      const buffer = Buffer.concat(chunks)
      const digest = createHash('sha256').update(buffer).digest('hex')
      if (digest !== entry.sha256) throw new Error('checksum mismatch')
      await writeFile(dest, buffer)
      if (process.platform !== 'win32') await chmod(dest, 0o755)
      await writeFile(
        join(dir, STAMP_NAME),
        JSON.stringify({ version: manifest.version, sha256: entry.sha256 }),
        'utf8',
      )
      log.info('music helper ready', { target: key })
      return dest
    } catch (error) {
      log.warn('music helper download failed', { error: String(error) })
      await rm(dest, { force: true })
      return null
    }
  }
}

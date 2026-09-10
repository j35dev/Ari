import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:music-runtime')

/** Directory inside application data holding the per-user music helper. */
export const MUSIC_RUNTIME_DIRNAME = 'ari-music-runtime'
const STAMP_NAME = '.runtime.json'
const MANIFEST_NAME = 'music-runtime.json'
const CACHED_MANIFEST_NAME = 'manifest.json'
/** Remote manifest re-check interval; Focus use between checks costs no fetch. */
const REMOTE_TTL_MS = 12 * 60 * 60_000
const MANIFEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/** Ari-owned manifest source; override with ARI_MUSIC_MANIFEST_URL (empty disables remote). */
const DEFAULT_REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/tahacore/Ari/main/apps/desktop/resources/music-runtime.json'

export interface MusicRuntimePlatform {
  url: string
  sha256: string
  binary: string
  size: number
}

export interface MusicRuntimeManifest {
  schemaVersion: number
  runtimeVersion: string
  platforms: Record<string, MusicRuntimePlatform>
}

/** Where the manifest and the user-data cache live. */
export interface MusicRuntimeEnvironment {
  /** True inside the packaged app; defaults to false (development layout). */
  isPackaged?: boolean
  resourcesPath: string
  appPath: string
  userDataPath?: string
  /** Remote manifest override (tests, mirrors); undefined reads the env var. */
  manifestUrl?: string
}

export type RuntimeProgress = (downloadedBytes: number, totalBytes: number | null) => void
export type ManifestSource = 'remote' | 'cached' | 'bundled'

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

function httpsUrl(value: unknown): string | null {
  const raw = asString(value)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

/**
 * Strict validation — the remote manifest is untrusted network input. Unknown
 * extra fields are ignored for forward compatibility; every required field
 * must match exactly or the whole manifest is rejected.
 */
export function validateMusicManifest(raw: unknown): MusicRuntimeManifest | null {
  const root = asRecord(raw)
  if (root?.['schemaVersion'] !== 1) return null
  const runtimeVersion = asString(root['runtimeVersion'])
  const platforms = asRecord(root['platforms'])
  if (!runtimeVersion || !platforms || Object.keys(platforms).length === 0) return null
  const checked: Record<string, MusicRuntimePlatform> = {}
  for (const [key, value] of Object.entries(platforms)) {
    const row = asRecord(value)
    const url = row ? httpsUrl(row['url']) : null
    const sha256 = row ? asString(row['sha256']) : null
    if (!url || !sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) return null
    const size = row?.['size']
    const binary = row?.['binary']
    checked[key] = {
      url,
      sha256: sha256.toLowerCase(),
      binary:
        typeof binary === 'string' && binary.length > 0
          ? binary
          : (basename(new URL(url).pathname) ?? 'helper'),
      size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
    }
  }
  return { schemaVersion: 1, runtimeVersion, platforms: checked }
}

/** Reads and validates the tiny bundled manifest; null when absent or malformed. */
export async function readMusicRuntimeManifest(
  env: MusicRuntimeEnvironment,
): Promise<MusicRuntimeManifest | null> {
  const root = env.isPackaged === true ? env.resourcesPath : join(env.appPath, 'resources')
  try {
    return validateMusicManifest(JSON.parse(await readFile(join(root, MANIFEST_NAME), 'utf8')))
  } catch {
    return null
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

interface RuntimeStamp {
  version: string
  sha256: string
}

async function readStamp(dir: string): Promise<RuntimeStamp | null> {
  try {
    const stamp: unknown = JSON.parse(await readFile(join(dir, STAMP_NAME), 'utf8'))
    const row = asRecord(stamp)
    const version = row ? asString(row['version']) : null
    const sha256 = row ? asString(row['sha256']) : null
    return version && sha256 ? { version, sha256 } : null
  } catch {
    return null
  }
}

function remoteManifestUrl(env: MusicRuntimeEnvironment): string | null {
  if (env.manifestUrl !== undefined) return env.manifestUrl.trim() || null
  const override = process.env['ARI_MUSIC_MANIFEST_URL']
  if (override !== undefined) return override.trim() || null
  return DEFAULT_REMOTE_MANIFEST_URL
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One architecture's music helper, cached per user. The installer ships only
 * the manifest; the ~18–40MB binary downloads on first Focus Music use into
 * application data, verified by SHA-256 before first run. A remote manifest
 * (same schema, Ari-owned URL) lets the runtime update — or roll back, since
 * the desired version is authoritative in both directions — without an Ari
 * release; the bundled manifest is the guaranteed fallback and remote state
 * is never a launch dependency. Users never install anything by hand and see
 * only "Preparing Focus Music…" while it fetches.
 */
export class MusicRuntime {
  readonly #env: MusicRuntimeEnvironment
  readonly #fetch: typeof fetch
  #ensuring: Promise<string | null> | null = null
  #manifest: { at: number; manifest: MusicRuntimeManifest; source: ManifestSource } | null = null

  constructor(env: MusicRuntimeEnvironment, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#env = env
    this.#fetch = fetchImpl
  }

  #cacheRoot(): string | null {
    if (!this.#env.userDataPath) return null
    return join(this.#env.userDataPath, MUSIC_RUNTIME_DIRNAME)
  }

  #cacheDir(key: string): string | null {
    const root = this.#cacheRoot()
    return root ? join(root, key) : null
  }

  /** Cached, verified binary — explicit override first (tests, development). */
  async binaryPath(): Promise<string | null> {
    const override = process.env['ARI_MUSIC_RUNTIME_BIN']?.trim()
    if (override && (await exists(override))) return override
    const key = musicRuntimeTargetKey()
    const dir = key ? this.#cacheDir(key) : null
    if (!key || !dir) return null
    const stamp = await readStamp(dir)
    // Every shipped manifest normalizes to one filename per OS.
    const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    if (!stamp || !(await exists(join(dir, binary)))) return null
    return join(dir, binary)
  }

  /** ready | downloading | missing | unavailable (unsupported platform). */
  async status(): Promise<'ready' | 'downloading' | 'missing' | 'unavailable'> {
    if (this.#ensuring) return 'downloading'
    if ((await this.binaryPath()) !== null) return 'ready'
    return musicRuntimeTargetKey() === null ? 'unavailable' : 'missing'
  }

  /**
   * Resolves the manifest through the remote → cached → bundled hierarchy.
   * A fresh disk cache is used with zero network; remote is TTL-gated and
   * never blocks on failure; `force` bypasses freshness once (self-heal).
   */
  async resolveManifest(options: { force?: boolean } = {}): Promise<{
    manifest: MusicRuntimeManifest | null
    source: ManifestSource
  }> {
    const started = Date.now()
    if (!options.force && this.#manifest && Date.now() - this.#manifest.at < REMOTE_TTL_MS) {
      return { manifest: this.#manifest.manifest, source: this.#manifest.source }
    }
    if (!options.force) {
      const fresh = await this.#readCachedManifest()
      if (fresh.fresh) {
        this.#manifest = { at: Date.now(), manifest: fresh.manifest, source: 'cached' }
        return { manifest: fresh.manifest, source: 'cached' }
      }
    }
    const url = remoteManifestUrl(this.#env)
    if (url) {
      try {
        const response = await fetchWithTimeout(this.#fetch, url, MANIFEST_TIMEOUT_MS)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const manifest = validateMusicManifest(await response.json())
        if (!manifest) throw new Error('manifest failed validation')
        await this.#writeCachedManifest(manifest)
        this.#manifest = { at: Date.now(), manifest, source: 'remote' }
        log.info('music manifest resolved', {
          source: 'remote',
          runtimeVersion: manifest.runtimeVersion,
          durationMs: Date.now() - started,
        })
        return { manifest, source: 'remote' }
      } catch (error) {
        log.warn('remote music manifest failed; falling back', { error: String(error) })
      }
    }
    const cached = await this.#readCachedManifest()
    if (cached.manifest) {
      this.#manifest = { at: Date.now(), manifest: cached.manifest, source: 'cached' }
      return { manifest: cached.manifest, source: 'cached' }
    }
    const bundled = await readMusicRuntimeManifest(this.#env)
    if (bundled) {
      this.#manifest = { at: Date.now(), manifest: bundled, source: 'bundled' }
      return { manifest: bundled, source: 'bundled' }
    }
    return { manifest: null, source: 'bundled' }
  }

  async #writeCachedManifest(manifest: MusicRuntimeManifest): Promise<void> {
    const root = this.#cacheRoot()
    if (!root) return
    try {
      await mkdir(root, { recursive: true })
      await writeFile(
        join(root, CACHED_MANIFEST_NAME),
        JSON.stringify({ fetchedAt: Date.now(), manifest }),
        'utf8',
      )
    } catch (error) {
      log.warn('music manifest cache write failed', { error: String(error) })
    }
  }

  async #readCachedManifest(): Promise<{ manifest: MusicRuntimeManifest | null; fresh: boolean }> {
    const root = this.#cacheRoot()
    if (!root) return { manifest: null, fresh: false }
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, CACHED_MANIFEST_NAME), 'utf8'))
      const row = asRecord(parsed)
      const manifest = row ? validateMusicManifest(row['manifest']) : null
      const fetchedAt = row?.['fetchedAt']
      const fresh =
        manifest !== null &&
        typeof fetchedAt === 'number' &&
        Date.now() - fetchedAt < REMOTE_TTL_MS
      if (manifest && fresh) log.info('music manifest resolved', { source: 'cached' })
      return { manifest, fresh }
    } catch {
      return { manifest: null, fresh: false }
    }
  }

  /** Drops cached manifest state so the next resolve re-fetches remote. */
  async forceRefresh(): Promise<{ manifest: MusicRuntimeManifest | null; source: ManifestSource }> {
    this.#manifest = null
    return this.resolveManifest({ force: true })
  }

  /**
   * Returns the verified binary, downloading it once on first use and moving
   * to whatever version the manifest desires (up or down) on later uses.
   * Concurrent callers share one in-flight attempt. A failed download keeps
   * any previously working binary instead of removing it.
   */
  async ensure(onProgress?: RuntimeProgress): Promise<string | null> {
    if (this.#ensuring) return this.#ensuring
    const attempt = this.#install(onProgress)
    this.#ensuring = attempt
    try {
      return await attempt
    } finally {
      if (this.#ensuring === attempt) this.#ensuring = null
    }
  }

  async #install(onProgress?: RuntimeProgress): Promise<string | null> {
    const started = Date.now()
    const key = musicRuntimeTargetKey()
    const dir = key ? this.#cacheDir(key) : null
    if (!key || !dir) return null
    const { manifest, source } = await this.resolveManifest()
    // Per-target fallback: a remote manifest missing this host still resolves
    // the bundled entry rather than stranding the platform.
    const bundled = await readMusicRuntimeManifest(this.#env)
    const entry = manifest?.platforms[key] ?? bundled?.platforms[key] ?? null
    if (!manifest || !entry) return null
    const dest = join(dir, entry.binary)
    const stamp = await readStamp(dir)
    if (stamp?.version === manifest.runtimeVersion && stamp.sha256 === entry.sha256) {
      if (await exists(dest)) return dest
    }
    const previous = await this.binaryPath()
    log.info('downloading music helper', {
      target: key,
      runtimeVersion: manifest.runtimeVersion,
      source,
      update: stamp !== null && stamp.version !== manifest.runtimeVersion,
    })
    const downloaded = await this.#download(entry.url, entry, dir, dest, onProgress)
    if (downloaded) {
      await writeFile(join(dir, STAMP_NAME), JSON.stringify({ version: manifest.runtimeVersion, sha256: entry.sha256 }), 'utf8').catch(
        (error: unknown) => log.warn('music stamp write failed', { error: String(error) }),
      )
      log.info('music helper ready', {
        target: key,
        runtimeVersion: manifest.runtimeVersion,
        source,
        durationMs: Date.now() - started,
      })
      return dest
    }
    if (previous) {
      log.warn('music helper download failed; keeping previous runtime')
      return previous
    }
    return null
  }

  async #download(
    url: string,
    entry: { sha256: string; size: number },
    dir: string,
    dest: string,
    onProgress?: RuntimeProgress,
  ): Promise<boolean> {
    const tmp = `${dest}.download`
    try {
      await mkdir(dir, { recursive: true })
      const response = await fetchWithTimeout(this.#fetch, url, DOWNLOAD_TIMEOUT_MS)
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
      await writeFile(tmp, buffer)
      if (process.platform !== 'win32') await chmod(tmp, 0o755)
      await rename(tmp, dest)
      return true
    } catch (error) {
      log.warn('music helper download failed', { error: String(error) })
      await rm(tmp, { force: true })
      return false
    }
  }
}

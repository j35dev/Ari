import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MUSIC_RUNTIME_DIRNAME,
  MusicRuntime,
  musicRuntimeTargetKey,
  readMusicRuntimeManifest,
  validateMusicManifest,
  type MusicRuntimeEnvironment,
  type MusicRuntimeManifest,
} from './music-runtime'

const PAYLOAD = Buffer.from('fake-helper-binary')
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')
const PAYLOAD_V2 = Buffer.from('fake-helper-binary-v2')
const PAYLOAD_V2_SHA = createHash('sha256').update(PAYLOAD_V2).digest('hex')
const HOST_KEY = musicRuntimeTargetKey() ?? 'linux-x64'
const BINARY = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const REMOTE_URL = 'https://example.invalid/music-runtime.json'

function manifestDoc(version: string, sha: string, url = 'https://example.invalid/helper.bin'): MusicRuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeVersion: version,
    platforms: { [HOST_KEY]: { url, sha256: sha, binary: BINARY, size: PAYLOAD.length } },
  }
}

async function fixtureRoot(bundled: MusicRuntimeManifest = manifestDoc('9.9.9', PAYLOAD_SHA)): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ari-music-runtime-'))
  await mkdir(join(root, 'resources'), { recursive: true })
  await writeFile(join(root, 'resources', 'music-runtime.json'), JSON.stringify(bundled))
  return root
}

function envFor(root: string, data = join(root, 'data')): MusicRuntimeEnvironment {
  return {
    resourcesPath: '',
    appPath: root,
    userDataPath: data,
    manifestUrl: REMOTE_URL,
  }
}

/** Routes manifest fetches to `remote()` and every other fetch to binary bytes. */
function routingFetch(
  remote: () => MusicRuntimeManifest | null | 'http500',
  bytes: Buffer | (() => Buffer) = PAYLOAD,
  onManifestFetch?: () => void,
): typeof fetch {
  return ((url: string) => {
    if (url === REMOTE_URL) {
      onManifestFetch?.()
      const doc = remote()
      if (doc === null) return Promise.resolve(new Response('down', { status: 404 }))
      if (doc === 'http500') return Promise.resolve(new Response('err', { status: 500 }))
      return Promise.resolve(
        new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }
    const payload = typeof bytes === 'function' ? bytes() : bytes
    const body = Uint8Array.from(payload)
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-length': String(payload.length) } }),
    )
  }) as typeof fetch
}

function fakeFetch(bytes: Buffer = PAYLOAD): typeof fetch {
  const body = Uint8Array.from(bytes)
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-length': String(bytes.length) } }),
    )
}

afterEach(() => {
  delete process.env['ARI_MUSIC_RUNTIME_BIN']
})

describe('musicRuntimeTargetKey', () => {
  it('maps supported platforms', () => {
    expect(musicRuntimeTargetKey('win32', 'x64')).toBe('win32-x64')
    expect(musicRuntimeTargetKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(musicRuntimeTargetKey('linux', 'arm64')).toBe('linux-arm64')
  })

  it('rejects unknown platforms and architectures', () => {
    expect(musicRuntimeTargetKey('freebsd', 'x64')).toBeNull()
    expect(musicRuntimeTargetKey('win32', 'ia32')).toBeNull()
  })
})

describe('validateMusicManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateMusicManifest(manifestDoc('1.0', PAYLOAD_SHA))?.runtimeVersion).toBe('1.0')
  })

  it('rejects wrong schema versions, bad hashes, and non-https URLs', () => {
    expect(validateMusicManifest({ ...manifestDoc('1.0', PAYLOAD_SHA), schemaVersion: 2 })).toBeNull()
    expect(validateMusicManifest(manifestDoc('1.0', 'not-a-hash'))).toBeNull()
    expect(
      validateMusicManifest(manifestDoc('1.0', PAYLOAD_SHA, 'http://example.invalid/h')),
    ).toBeNull()
    expect(validateMusicManifest({ schemaVersion: 1 })).toBeNull()
    expect(validateMusicManifest(null)).toBeNull()
  })
})

describe('MusicRuntime', () => {
  it('reads the bundled manifest', async () => {
    const root = await fixtureRoot()
    const manifest = await readMusicRuntimeManifest({ resourcesPath: '', appPath: root })
    expect(manifest?.runtimeVersion).toBe('9.9.9')
    expect(manifest?.platforms[HOST_KEY]?.sha256).toBe(PAYLOAD_SHA)
  })

  it('returns null for a malformed manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-music-bad-'))
    await mkdir(join(root, 'resources'), { recursive: true })
    await writeFile(join(root, 'resources', 'music-runtime.json'), '{oops')
    const runtime = new MusicRuntime({ resourcesPath: '', appPath: root, userDataPath: join(root, 'data') })
    expect(await runtime.binaryPath()).toBeNull()
  })

  it('reports missing before the first download', async () => {
    const root = await fixtureRoot()
    const runtime = new MusicRuntime(envFor(root), fakeFetch())
    expect(await runtime.status()).toBe('missing')
    expect(await runtime.binaryPath()).toBeNull()
  })

  it('downloads, verifies, and caches the helper', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    // No remote configured here: bundled manifest serves directly.
    const env: MusicRuntimeEnvironment = {
      resourcesPath: '',
      appPath: root,
      userDataPath: join(root, 'data'),
      manifestUrl: '',
    }
    const fetch = vi.fn(fakeFetch())
    const runtime = new MusicRuntime(env, fetch)
    const progress: number[] = []
    const binary = await runtime.ensure((received) => progress.push(received))
    expect(binary).toBe(join(env.userDataPath as string, MUSIC_RUNTIME_DIRNAME, HOST_KEY, BINARY))
    expect(await readFile(binary as string)).toEqual(PAYLOAD)
    expect(progress.at(-1)).toBe(PAYLOAD.length)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await runtime.ensure()).toBe(binary)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await runtime.status()).toBe('ready')
  })

  it('shares one download across concurrent callers', async () => {
    const root = await fixtureRoot()
    const fetch = vi.fn(routingFetch(() => manifestDoc('9.9.9', PAYLOAD_SHA)))
    const runtime = new MusicRuntime(envFor(root), fetch)
    const [a, b] = await Promise.all([runtime.ensure(), runtime.ensure()])
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    const env: MusicRuntimeEnvironment = {
      resourcesPath: '',
      appPath: root,
      userDataPath: join(root, 'data'),
      manifestUrl: '',
    }
    const runtime = new MusicRuntime(env, fakeFetch(Buffer.from('tampered')))
    expect(await runtime.ensure()).toBeNull()
    expect(await runtime.binaryPath()).toBeNull()
  })

  it('honours an explicit binary override', async () => {
    const root = await fixtureRoot()
    const override = join(root, 'custom-helper')
    await writeFile(override, 'x')
    process.env['ARI_MUSIC_RUNTIME_BIN'] = override
    const runtime = new MusicRuntime({ resourcesPath: '', appPath: root }, fakeFetch())
    expect(await runtime.binaryPath()).toBe(override)
  })

  it('prefers the remote manifest and downloads its runtime', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    const runtime = new MusicRuntime(
      envFor(root),
      routingFetch(() => manifestDoc('1.2.0', PAYLOAD_SHA)),
    )
    const binary = await runtime.ensure()
    expect(binary).not.toBeNull()
    expect(await readFile(binary as string)).toEqual(PAYLOAD)
    const stamp = JSON.parse(
      await readFile(join(join(root, 'data'), MUSIC_RUNTIME_DIRNAME, HOST_KEY, '.runtime.json'), 'utf8'),
    ) as { version: string }
    expect(stamp.version).toBe('1.2.0')
  })

  it('falls back to the bundled manifest when remote is down', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    const runtime = new MusicRuntime(
      envFor(root),
      routingFetch(() => null),
    )
    const binary = await runtime.ensure()
    expect(binary).not.toBeNull()
    expect(await readFile(binary as string)).toEqual(PAYLOAD)
  })

  it('rejects an invalid remote manifest and uses bundled', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    const runtime = new MusicRuntime(
      envFor(root),
      routingFetch(() => ({ schemaVersion: 2, runtimeVersion: 'x', platforms: {} })),
    )
    expect(await runtime.ensure()).not.toBeNull()
  })

  it('keeps the working runtime when the new download fails verification', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    const live = {
      remote: manifestDoc('1.0.0', PAYLOAD_SHA) as MusicRuntimeManifest | null,
      bytes: PAYLOAD,
    }
    const runtime = new MusicRuntime(
      envFor(root),
      routingFetch(() => live.remote, () => live.bytes),
    )
    const first = await runtime.ensure()
    expect(first).not.toBeNull()
    // New version announced, but its bytes do not match its checksum.
    live.remote = manifestDoc('2.0.0', PAYLOAD_V2_SHA)
    live.bytes = Buffer.from('corrupted')
    const kept = await runtime.ensure()
    expect(kept).toBe(first)
    expect(await readFile(first as string)).toEqual(PAYLOAD)
  })

  it('rolls back when the manifest points to an older runtime', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    let remote: MusicRuntimeManifest | null = manifestDoc('2.0.0', PAYLOAD_V2_SHA)
    const fetchImpl: typeof fetch = (async (url: string) => {
      if (url === REMOTE_URL) {
        return new Response(JSON.stringify(remote), { status: 200 })
      }
      const body = remote?.runtimeVersion === '2.0.0' ? PAYLOAD_V2 : PAYLOAD
      return new Response(Uint8Array.from(body), { status: 200 })
    }) as typeof fetch
    const runtime = new MusicRuntime(envFor(root), fetchImpl)
    expect(await readFile((await runtime.ensure()) as string)).toEqual(PAYLOAD_V2)
    remote = manifestDoc('1.0.0', PAYLOAD_SHA)
    await runtime.forceRefresh()
    expect(await readFile((await runtime.ensure()) as string)).toEqual(PAYLOAD)
  })

  it('caches the remote manifest for the TTL and refreshes on demand', async () => {
    const root = await fixtureRoot(manifestDoc('9.9.9', PAYLOAD_SHA))
    let remote: MusicRuntimeManifest | null = manifestDoc('1.0.0', PAYLOAD_SHA)
    let manifestFetches = 0
    const runtime = new MusicRuntime(
      envFor(root),
      routingFetch(() => remote, PAYLOAD, () => manifestFetches++),
    )
    await runtime.ensure()
    expect(manifestFetches).toBe(1)
    remote = manifestDoc('2.0.0', PAYLOAD_V2_SHA)
    await runtime.ensure()
    expect(manifestFetches).toBe(1)
    await runtime.forceRefresh()
    expect(manifestFetches).toBe(2)
  })
})

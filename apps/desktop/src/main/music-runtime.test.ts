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
} from './music-runtime'

const PAYLOAD = Buffer.from('fake-helper-binary')
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')
const HOST_KEY = musicRuntimeTargetKey() ?? 'linux-x64'
const BINARY = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ari-music-runtime-'))
  const manifest = {
    version: '9.9.9',
    baseUrl: 'https://example.invalid/r',
    targets: {
      [HOST_KEY]: { asset: 'helper.bin', sha256: PAYLOAD_SHA, binary: BINARY, size: PAYLOAD.length },
    },
  }
  await mkdir(join(root, 'resources'), { recursive: true })
  await writeFile(join(root, 'resources', 'music-runtime.json'), JSON.stringify(manifest))
  return root
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

describe('MusicRuntime', () => {
  it('reads the bundled manifest', async () => {
    const root = await fixtureRoot()
    const manifest = await readMusicRuntimeManifest({
      isPackaged: false,
      resourcesPath: '',
      appPath: root,
      userDataPath: join(root, 'data'),
    })
    expect(manifest?.version).toBe('9.9.9')
    expect(manifest?.targets[HOST_KEY]?.sha256).toBe(PAYLOAD_SHA)
  })

  it('returns null for a malformed manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-music-bad-'))
    await mkdir(join(root, 'resources'), { recursive: true })
    await writeFile(join(root, 'resources', 'music-runtime.json'), '{oops')
    const runtime = new MusicRuntime({
      isPackaged: false,
      resourcesPath: '',
      appPath: root,
      userDataPath: join(root, 'data'),
    })
    expect(await runtime.binaryPath()).toBeNull()
  })

  it('reports missing before the first download', async () => {
    const root = await fixtureRoot()
    const runtime = new MusicRuntime(
      { isPackaged: false, resourcesPath: '', appPath: root, userDataPath: join(root, 'data') },
      fakeFetch(),
    )
    expect(await runtime.status()).toBe('missing')
    expect(await runtime.binaryPath()).toBeNull()
  })

  it('downloads, verifies, and caches the helper', async () => {
    const root = await fixtureRoot()
    const fetch = vi.fn(fakeFetch())
    const data = join(root, 'data')
    const runtime = new MusicRuntime(
      { isPackaged: false, resourcesPath: '', appPath: root, userDataPath: data },
      fetch,
    )
    const progress: number[] = []
    const binary = await runtime.ensure((received) => progress.push(received))
    expect(binary).toBe(join(data, MUSIC_RUNTIME_DIRNAME, HOST_KEY, BINARY))
    expect(await readFile(binary as string)).toEqual(PAYLOAD)
    expect(progress.at(-1)).toBe(PAYLOAD.length)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Second ensure is a cache hit — no second download.
    expect(await runtime.ensure()).toBe(binary)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await runtime.status()).toBe('ready')
  })

  it('shares one download across concurrent callers', async () => {
    const root = await fixtureRoot()
    const fetch = vi.fn(fakeFetch())
    const runtime = new MusicRuntime(
      { isPackaged: false, resourcesPath: '', appPath: root, userDataPath: join(root, 'data') },
      fetch,
    )
    const [a, b] = await Promise.all([runtime.ensure(), runtime.ensure()])
    expect(a).toBe(b)
    expect(a).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    const root = await fixtureRoot()
    const data = join(root, 'data')
    const runtime = new MusicRuntime(
      { isPackaged: false, resourcesPath: '', appPath: root, userDataPath: data },
      fakeFetch(Buffer.from('tampered')),
    )
    expect(await runtime.ensure()).toBeNull()
    expect(await runtime.binaryPath()).toBeNull()
  })

  it('honours an explicit binary override', async () => {
    const root = await fixtureRoot()
    const override = join(root, 'custom-helper')
    await writeFile(override, 'x')
    process.env['ARI_MUSIC_RUNTIME_BIN'] = override
    const runtime = new MusicRuntime(
      { isPackaged: false, resourcesPath: '', appPath: root },
      fakeFetch(),
    )
    expect(await runtime.binaryPath()).toBe(override)
  })
})

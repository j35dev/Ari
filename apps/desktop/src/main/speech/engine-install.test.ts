// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { c } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { ENGINE_HEADER_HASH, ENGINE_VERSION, installEngine, verifyInstalledEngine } from './engine'
import * as download from './download'

const fixture = vi.hoisted(() => ({
  release: {
    filename: `transcribe-native-0.4.1-${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.platform === 'linux' && process.arch === 'arm64' ? 'aarch64' : process.arch}-${process.platform === 'darwin' ? (process.arch === 'arm64' ? 'metal' : 'cpu') : 'cpu-vulkan'}.tar.gz`,
    size: 0,
    sha256: '',
    url: '',
    files: {} as Record<string, { size: number; sha256: string }>,
  },
}))
vi.mock('./engine-releases.json', () => ({ default: [fixture.release] }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([true, false])(
  'hashes each archive and staged library once (cached archive: %s)',
  async (cached) => {
    const root = await mkdtemp(join(tmpdir(), 'ari-engine-install-'))
    roots.push(root)
    const source = join(root, 'source')
    const engine = join(root, 'engine')
    await mkdir(join(source, 'native'), { recursive: true })
    await mkdir(engine)
    const files = {
      'native/transcribe.dll': 'native library',
      'native/contract.json': JSON.stringify({
        version: ENGINE_VERSION,
        header_hash: ENGINE_HEADER_HASH,
      }),
    }
    fixture.release.files = {}
    for (const [path, bytes] of Object.entries(files)) {
      await writeFile(join(source, path), bytes)
      fixture.release.files[path] = {
        size: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    }
    const archive = join(engine, fixture.release.filename)
    await c({ gzip: true, cwd: source, file: archive }, ['native'])
    const bytes = await readFile(archive)
    fixture.release.size = bytes.length
    fixture.release.sha256 = createHash('sha256').update(bytes).digest('hex')
    if (!cached) {
      await rm(archive)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)))
    }
    const hashes = vi.spyOn(download, 'verifyDownload')
    const verified = vi.fn()
    const library = await installEngine(engine, new AbortController().signal, vi.fn(), verified)
    expect(library).toBe(join(engine, ENGINE_VERSION, 'native/transcribe.dll'))
    expect(await readFile(library, 'utf8')).toBe('native library')
    expect(hashes.mock.calls.filter(([path]) => path.endsWith('.dll'))).toHaveLength(1)
    expect(hashes.mock.calls.filter(([path]) => path === archive)).toHaveLength(cached ? 1 : 0)
    expect(
      hashes.mock.calls.some(([path]) => path.startsWith(`${join(engine, ENGINE_VERSION)}${sep}`)),
    ).toBe(false)
    await verifyInstalledEngine(join(engine, ENGINE_VERSION), false, undefined, verified)
    expect(verified.mock.calls[1]![0]).toBe(verified.mock.calls[0]![0])
  },
)

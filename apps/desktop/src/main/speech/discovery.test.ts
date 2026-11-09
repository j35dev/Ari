// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./catalog.json', () => ({
  default: [
    {
      id: 'small',
      name: 'Small',
      description: 'Test',
      languages: ['en'],
      filename: 'small.gguf',
      size: 4,
      sha256: 'a'.repeat(64),
      repository: 'test/small',
      revision: 'b'.repeat(40),
    },
  ],
}))
import { catalog, discoverModels, handyDataDirectory, modelRoots } from './discovery'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'ari-speech-'))
  dirs.push(dir)
  return dir
}

describe('speech discovery', () => {
  it('finds portable Handy on PATH and respects an existing HF cache location', async () => {
    const portable = await folder()
    const cache = await folder()
    vi.stubEnv('PATH', portable)
    vi.stubEnv('HF_HUB_CACHE', cache)
    await writeFile(join(portable, 'portable'), 'Handy Portable Mode')
    await writeFile(join(portable, process.platform === 'win32' ? 'Handy.exe' : 'handy'), '')
    expect(await modelRoots(join(portable, 'ari-models'))).toEqual(
      expect.arrayContaining([
        { path: join(portable, 'Data', 'models'), source: 'handy' },
        { path: cache, source: 'other', depth: 4 },
      ]),
    )
  })
  it('resolves Handy layouts and XDG overrides on every platform', () => {
    expect(handyDataDirectory('win32', '/home', { APPDATA: '/roaming' })).toBe(
      join('/roaming', 'com.pais.handy'),
    )
    expect(handyDataDirectory('darwin', '/home', {})).toBe(
      join('/home', 'Library', 'Application Support', 'com.pais.handy'),
    )
    expect(handyDataDirectory('linux', '/home', {})).toBe(
      join('/home', '.local', 'share', 'com.pais.handy'),
    )
    expect(handyDataDirectory('linux', '/home', { XDG_DATA_HOME: '/data' })).toBe(
      join('/data', 'com.pais.handy'),
    )
  })
  it('matches catalog filenames in place and offers custom GGUF files', async () => {
    const handy = await folder()
    await writeFile(join(handy, 'small.gguf'), 'gguf')
    await writeFile(join(handy, 'custom.gguf'), 'custom')
    await writeFile(join(handy, 'ggml-small.bin'), 'legacy')
    await writeFile(join(handy, 'unfinished.gguf.partial'), 'partial')
    const models = await discoverModels([{ path: handy, source: 'handy' }])
    expect(models).toHaveLength(2)
    expect(models[0]?.installed).toEqual({ path: join(handy, 'small.gguf'), source: 'handy' })
    expect(models[1]?.name).toBe('custom.gguf')
    expect(catalog[0]).not.toHaveProperty('installed')
  })
  it('prefers Ari copies, finds HF snapshots, and rejects truncated catalog files', async () => {
    const own = await folder()
    const cache = await folder()
    const snapshot = join(cache, 'models--test--small', 'snapshots', 'revision')
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(own, 'small.gguf'), 'bad')
    await writeFile(join(snapshot, 'small.gguf'), 'gguf')
    let models = await discoverModels([
      { path: own, source: 'ari' },
      { path: cache, source: 'other', depth: 4 },
    ])
    expect(models[0]?.installed).toEqual({ path: join(snapshot, 'small.gguf'), source: 'other' })
    await writeFile(join(own, 'small.gguf'), 'gguf')
    models = await discoverModels([
      { path: own, source: 'ari' },
      { path: cache, source: 'other', depth: 4 },
    ])
    expect(models[0]?.installed).toEqual({ path: join(own, 'small.gguf'), source: 'ari' })
  })
})

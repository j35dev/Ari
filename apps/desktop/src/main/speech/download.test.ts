// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadFile, prunePartialDownloads } from './download'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true })
})
async function target() {
  const dir = await mkdtemp(join(tmpdir(), 'ari-download-'))
  dirs.push(dir)
  return join(dir, 'model.gguf')
}
const bytes = Buffer.from('verified local model')
const digest = createHash('sha256').update(bytes).digest('hex')
const options = (path: string) => ({
  id: 'test',
  path,
  url: 'https://example.test/model',
  size: bytes.length,
  sha256: digest,
  signal: new AbortController().signal,
  progress: vi.fn(),
})

it('verifies bytes before publishing the completed filename', async () => {
  const path = await target()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)))
  await downloadFile(options(path))
  expect(await readFile(path)).toEqual(bytes)
  await expect(readFile(`${path}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('removes a corrupt partial file and never installs it', async () => {
  const path = await target()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.alloc(bytes.length))))
  await expect(downloadFile(options(path))).rejects.toThrow('checksum')
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(`${path}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('cancels safely and resumes a verified partial file', async () => {
  const path = await target()
  const abort = new AbortController()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)))
  await expect(
    downloadFile({ ...options(path), signal: abort.signal, progress: () => abort.abort() }),
  ).rejects.toThrow()
  expect(await readFile(`${path}.partial`)).toEqual(bytes)
  await downloadFile(options(path))
  expect(await readFile(path)).toEqual(bytes)
})
it('uses ranges for partial files and restarts if the server ignores them', async () => {
  const path = await target()
  await writeFile(`${path}.partial`, bytes.subarray(0, 5))
  const fetcher = vi.fn().mockResolvedValue(
    new Response(bytes.subarray(5), {
      status: 206,
      headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` },
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  await downloadFile(options(path))
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { Range: 'bytes=5-' } })
  expect(await readFile(path)).toEqual(bytes)
  await rm(path)
  await writeFile(`${path}.partial`, bytes.subarray(0, 5))
  fetcher.mockResolvedValue(new Response(bytes))
  await downloadFile(options(path))
  expect(await readFile(path)).toEqual(bytes)
})

it('prunes expired partials, keeps active downloads, and discards other partials on model choice', async () => {
  const path = await target()
  const root = dirname(path)
  const old = join(root, 'old.gguf.partial')
  const active = join(root, 'active.gguf.partial')
  const recent = `${path}.partial`
  const legacy = join(root, 'other.bin.partial')
  for (const file of [old, active, recent, legacy]) await writeFile(file, 'saved')
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60_000)
  await utimes(old, expired, expired)
  await utimes(active, expired, expired)
  await prunePartialDownloads(root, new Set(['active.gguf.partial']))
  await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(active, 'utf8')).toBe('saved')
  expect(await readFile(recent, 'utf8')).toBe('saved')
  await prunePartialDownloads(root, new Set(['active.gguf.partial']), 0)
  await expect(readFile(recent)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(legacy, 'utf8')).toBe('saved')
})

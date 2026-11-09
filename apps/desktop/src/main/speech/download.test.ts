// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadFile } from './download'

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
  const fetcher = vi
    .fn()
    .mockResolvedValue(
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

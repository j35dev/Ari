// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  ENGINE_HEADER_HASH,
  ENGINE_VERSION,
  engineRelease,
  verifyInstalledEngine,
  type EngineRelease,
  EngineIoError,
} from './engine'

const io = vi.hoisted(() => ({ lstat: vi.fn() }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, lstat: io.lstat }
})
beforeEach(async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  io.lstat.mockReset().mockImplementation(actual.lstat)
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ari-engine-integrity-'))
  roots.push(root)
  const content: Record<string, string> = {
    'native/transcribe.dll': 'native library',
    'native/ggml.dll': 'dependency',
    'native/contract.json': JSON.stringify({
      version: ENGINE_VERSION,
      header_hash: ENGINE_HEADER_HASH,
    }),
  }
  const release: EngineRelease = { filename: 'fixture', size: 0, sha256: '', url: '', files: {} }
  await mkdir(join(root, 'native'))
  for (const [path, bytes] of Object.entries(content)) {
    await writeFile(join(root, path), bytes)
    release.files[path] = {
      size: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  return { root, release }
}

it('verifies every installed library against shipped hashes before loading', async () => {
  const { root, release } = await fixture()
  expect(await verifyInstalledEngine(root, true, release)).toBe(join(root, 'native/transcribe.dll'))
  await writeFile(join(root, 'native/ggml.dll'), 'DEPENDENCY')
  expect(await verifyInstalledEngine(root, true, release)).toBeNull()
})

it('detects missing dependencies and unexpected native files in cheap status checks', async () => {
  const { root, release } = await fixture()
  await rm(join(root, 'native/ggml.dll'))
  expect(await verifyInstalledEngine(root, false, release)).toBeNull()
  const other = await fixture()
  await writeFile(join(other.root, 'native/extra.dll'), 'unexpected')
  expect(await verifyInstalledEngine(other.root, false, other.release)).toBeNull()
})

it('requires the binding version and public header contract even with valid hashes', async () => {
  const { root, release } = await fixture()
  const bytes = JSON.stringify({ version: ENGINE_VERSION, header_hash: 'wrong header' })
  await writeFile(join(root, 'native/contract.json'), bytes)
  release.files['native/contract.json'] = {
    size: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  expect(await verifyInstalledEngine(root, true, release)).toBeNull()
})

it('maps only supported Linux architectures', () => {
  expect(engineRelease('linux', 'x64').filename).toContain('linux-x86_64')
  expect(engineRelease('linux', 'arm64').filename).toContain('linux-aarch64')
  for (const arch of ['arm', 'ia32', 'riscv64', 'ppc64'] as const) {
    expect(() => engineRelease('linux', arch)).toThrow(`not available on linux ${arch}`)
  }
})

it('ignores OS metadata and untracked dotfiles while verifying manifest files', async () => {
  const { root, release } = await fixture()
  for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.notes'])
    await writeFile(join(root, 'native', name), 'metadata')
  expect(await verifyInstalledEngine(root, true, release)).toBe(join(root, 'native/transcribe.dll'))
})

it('retries temporary read failures and distinguishes persistent I/O errors from mismatches', async () => {
  const { root, release } = await fixture()
  io.lstat.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
  expect(await verifyInstalledEngine(root, true, release)).toBe(join(root, 'native/transcribe.dll'))
  io.lstat.mockReset().mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }))
  await expect(verifyInstalledEngine(root, true, release)).rejects.toBeInstanceOf(EngineIoError)
  expect(io.lstat).toHaveBeenCalledTimes(3)
})

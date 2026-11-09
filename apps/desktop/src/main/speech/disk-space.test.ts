// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type * as FileSystem from 'node:fs/promises'
import { ensureFreeSpace } from './download'

const mocks = vi.hoisted(() => ({ statfs: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  statfs: mocks.statfs,
}))
it('reports insufficient disk space before starting a model download or engine extraction', async () => {
  mocks.statfs.mockResolvedValue({ bavail: 10, bsize: 4096 })
  await expect(ensureFreeSpace('/speech', 35_000_000)).rejects.toThrow('Not enough disk space')
})
it('allows installations with headroom and only tolerates unsupported disk probes', async () => {
  mocks.statfs.mockResolvedValue({ bavail: 100_000, bsize: 4096 })
  await expect(ensureFreeSpace('/speech', 35_000_000)).resolves.toBeUndefined()
  mocks.statfs.mockRejectedValue({ code: 'ENOSYS' })
  await expect(ensureFreeSpace('/speech', 35_000_000)).resolves.toBeUndefined()
  mocks.statfs.mockRejectedValue({ code: 'EACCES' })
  await expect(ensureFreeSpace('/speech', 35_000_000)).rejects.toMatchObject({ code: 'EACCES' })
})

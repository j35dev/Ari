// @vitest-environment node
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prunePartialDownloads } from './download'

const io = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn(), rm: vi.fn() }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  ...io,
}))
beforeEach(() => Object.values(io).forEach((mock) => mock.mockReset()))
afterEach(() => vi.restoreAllMocks())

it('logs a locked partial and continues cleaning the other files', async () => {
  io.readdir.mockResolvedValue(
    ['locked.partial', 'old.partial'].map((name) => ({ name, isFile: () => true })),
  )
  io.stat.mockResolvedValue({ mtimeMs: 0 })
  io.rm
    .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
    .mockResolvedValue(undefined)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await expect(
    prunePartialDownloads('/speech/engine', new Set(), undefined, '.partial'),
  ).resolves.toBeUndefined()
  expect(io.rm).toHaveBeenCalledWith(join('/speech/engine', 'old.partial'), { force: true })
  expect(warning).toHaveBeenCalledOnce()
})

it('logs a temporarily inaccessible directory without rejecting startup cleanup', async () => {
  io.readdir.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await expect(prunePartialDownloads('/speech/engine', new Set())).resolves.toBeUndefined()
  expect(warning).toHaveBeenCalledOnce()
})

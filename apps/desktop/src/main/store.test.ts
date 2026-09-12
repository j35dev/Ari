// @vitest-environment node
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string
let folder: string

const mocks = vi.hoisted(() => ({ getPath: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const { getProjectStore, loadProject } = await import('./store')

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'ari-store-'))
  folder = join(userData, 'checkout')
  await mkdir(folder)
  mocks.getPath.mockReturnValue(userData)
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('loadProject', () => {
  it('resolves a registered project id', async () => {
    const added = await getProjectStore().add(folder, 'Checkout')

    await expect(loadProject(added.id)).resolves.toMatchObject({ id: added.id, name: 'Checkout' })
  })

  it.each(['adhoc', 'proj_that_never_existed'])(
    'refuses %s, which names no project',
    async (projectId) => {
      // The legacy no-project bucket is just an id nothing registered, so it
      // falls out of the same check that catches a stale or forged one.
      await expect(loadProject(projectId)).rejects.toThrow(
        'a session needs a project — add a folder first',
      )
    },
  )

  it('keeps accepting a project whose folder has gone missing', async () => {
    const added = await getProjectStore().add(folder, 'Checkout')
    await rm(folder, { recursive: true, force: true })

    // A missing folder is a spawn failure the engine reports, not a reason to
    // block the session from being created at all.
    await expect(loadProject(added.id)).resolves.toMatchObject({ id: added.id, status: 'missing' })
  })
})

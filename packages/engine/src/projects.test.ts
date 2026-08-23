import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from './projects'

let dir: string
let existingFolder: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-projects-'))
  existingFolder = join(dir, 'my-project')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(existingFolder, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ProjectStore', () => {
  it('adds an existing folder with a derived name', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(existingFolder)
    expect(project?.name).toBe('my-project')
    expect(project?.colorIndex).toBe(0)
  })

  it('rejects non-existent folders', async () => {
    const store = new ProjectStore({ dir })
    expect(await store.add(join(dir, 'nope'))).toBeNull()
  })

  it('deduplicates by path case-insensitively', async () => {
    const store = new ProjectStore({ dir })
    const first = await store.add(existingFolder)
    const again = await store.add(existingFolder)
    expect(again?.id).toBe(first?.id)
    expect(store.list()).toHaveLength(1)
    // Linux paths are case-sensitive; the uppercased folder does not exist.
    if (process.platform === 'win32') {
      const folded = await store.add(existingFolder.toUpperCase())
      expect(folded?.id).toBe(first?.id)
      expect(store.list()).toHaveLength(1)
    }
  })

  it('persists across instances and removes cleanly', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(existingFolder)
    const reloaded = new ProjectStore({ dir })
    expect((await reloaded.load()).map((p) => p.id)).toEqual([project?.id])
    expect(await reloaded.remove(project?.id ?? '')).toBe(true)
    expect(reloaded.list()).toHaveLength(0)
  })
})

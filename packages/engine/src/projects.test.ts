import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore, canonicalizeFolder } from './projects'

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
    expect(project.name).toBe('my-project')
    expect(project.colorIndex).toBe(0)
    expect(project.status).toBe('ok')
    expect(project.open).toBe(false)
  })

  it('records a missing folder in the degraded state instead of rejecting it', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(join(dir, 'nope'))
    expect(project.status).toBe('missing')
    expect(store.list()).toHaveLength(1)
  })

  it('deduplicates on the canonical path', async () => {
    const store = new ProjectStore({ dir })
    const first = await store.add(existingFolder)
    expect(first.path).toBe(await canonicalizeFolder(existingFolder))
    // Same folder reached through a non-canonical spelling.
    const again = await store.add(join(existingFolder, '.'))
    expect(again.id).toBe(first.id)
    expect(store.list()).toHaveLength(1)
    // Linux paths are case-sensitive; the uppercased folder does not exist.
    if (process.platform === 'win32') {
      const folded = await store.add(existingFolder.toUpperCase())
      expect(folded.id).toBe(first.id)
      expect(store.list()).toHaveLength(1)
    }
  })

  it('open marks the project open, stamps lastOpenedAt and reuses duplicates', async () => {
    const store = new ProjectStore({ dir })
    const opened = await store.open(existingFolder)
    expect(opened.open).toBe(true)
    expect(opened.lastOpenedAt).toBeGreaterThan(0)
    expect(store.listOpen().map((p) => p.id)).toEqual([opened.id])

    const again = await store.open(join(existingFolder, '.'))
    expect(again.id).toBe(opened.id)
    expect(store.list()).toHaveLength(1)
  })

  it('close keeps the project while remove forgets it', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)

    const closed = await store.close(project.id)
    expect(closed?.open).toBe(false)
    expect(store.get(project.id)).not.toBeNull()
    expect(store.list()).toHaveLength(1)
    expect(store.listOpen()).toHaveLength(0)

    expect(await store.remove(project.id)).toBe(true)
    expect(store.get(project.id)).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  it('persists open state across instances', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    const reloaded = new ProjectStore({ dir })
    const loaded = await reloaded.load()
    expect(loaded.map((p) => p.id)).toEqual([project.id])
    expect(loaded[0]?.open).toBe(true)
  })

  it('persists across instances and removes cleanly', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(existingFolder)
    const reloaded = new ProjectStore({ dir })
    expect((await reloaded.load()).map((p) => p.id)).toEqual([project.id])
    expect(await reloaded.remove(project.id)).toBe(true)
    expect(reloaded.list()).toHaveLength(0)
  })
})

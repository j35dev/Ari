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

  it('move slots a project before a sibling and persists the order', async () => {
    const store = new ProjectStore({ dir })
    const a = await store.add(join(dir, 'a'))
    const b = await store.add(join(dir, 'b'))
    const c = await store.add(join(dir, 'c'))

    expect((await store.move(c.id, a.id))?.id).toBe(c.id)
    expect(store.list().map((p) => p.id)).toEqual([c.id, a.id, b.id])

    // beforeId null appends last.
    await store.move(c.id, null)
    expect(store.list().map((p) => p.id)).toEqual([a.id, b.id, c.id])

    // The sidebar order survives a restart.
    const reloaded = await new ProjectStore({ dir }).load()
    expect(reloaded.map((p) => p.id)).toEqual([a.id, b.id, c.id])
  })

  it('move reorders among open projects without disturbing closed ones', async () => {
    const store = new ProjectStore({ dir })
    const open = await store.open(join(dir, 'open'))
    const hidden = await store.add(join(dir, 'hidden'))
    const other = await store.open(join(dir, 'other'))
    await store.close(hidden.id)

    // Inserting before `other` lands ahead of it even with a closed project
    // in between — only the relative order of open projects is visible.
    await store.move(open.id, other.id)
    expect(store.listOpen().map((p) => p.id)).toEqual([open.id, other.id])
    expect(store.list().map((p) => p.id)).toEqual([hidden.id, open.id, other.id])
  })

  it('move is a no-op for unknown ids', async () => {
    const store = new ProjectStore({ dir })
    const a = await store.add(join(dir, 'a'))
    const b = await store.add(join(dir, 'b'))

    expect(await store.move('proj_none', null)).toBeNull()
    expect(await store.move(a.id, 'proj_none')).toBeNull()
    expect(store.list().map((p) => p.id)).toEqual([a.id, b.id])
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

  it('ignores a second load so a slow disk read cannot clobber mutations', async () => {
    const store = new ProjectStore({ dir })
    await store.load()
    const project = await store.add(existingFolder)

    // Another handler calls load() (e.g. project.list) while the store holds
    // the unsaved-to-disk mutation above; it must not resurrect old state.
    await store.load()
    expect(store.list().map((p) => p.id)).toEqual([project.id])
  })
})

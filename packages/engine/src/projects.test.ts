import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('restores the same project id when a removed folder is added back', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    await store.remove(project.id)

    // Sessions still carry `projectId`; if re-adding minted a new id they would
    // resolve to no workspace and stay broken for good.
    const readded = await store.add(existingFolder)
    expect(readded.id).toBe(project.id)
    expect(store.get(project.id)).not.toBeNull()
    expect(store.list()).toHaveLength(1)
  })

  it('survives a restart between removing a folder and adding it back', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    await store.remove(project.id)

    // The tombstone is on disk, not just in memory.
    const next = new ProjectStore({ dir })
    expect(await next.load()).toHaveLength(0)
    expect((await next.add(existingFolder)).id).toBe(project.id)
  })

  it('keeps a removed project out of the listing and out of get', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    expect(await store.remove(project.id)).toBe(true)

    expect(store.list()).toHaveLength(0)
    expect(store.listOpen()).toHaveLength(0)
    expect(store.get(project.id)).toBeNull()
    // Nothing to remove the second time.
    expect(await store.remove(project.id)).toBe(false)
  })

  it('replaces a stale tombstone instead of stacking a second one', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(existingFolder)
    await store.remove(project.id)
    await store.remove(project.id)

    const readded = await store.add(existingFolder)
    expect(readded.id).toBe(project.id)
    expect(store.list()).toHaveLength(1)
  })

  it('honours a name given while restoring a removed folder', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(existingFolder, 'Original')
    await store.remove(project.id)

    expect((await store.add(existingFolder, 'Renamed')).name).toBe('Renamed')
    // Without one, the name it was removed under comes back.
    await store.remove(project.id)
    expect((await store.add(existingFolder)).name).toBe('Renamed')
  })

  it('loads a registry written before tombstones existed', async () => {
    await writeFile(
      join(dir, 'projects.json'),
      JSON.stringify([
        {
          id: 'proj_legacy',
          name: 'Legacy',
          path: existingFolder,
          colorIndex: 2,
          createdAt: 1,
          lastOpenedAt: 2,
          open: true,
        },
      ]),
      'utf8',
    )

    const store = new ProjectStore({ dir })
    const loaded = await store.load()
    expect(loaded.map((p) => [p.id, p.name, p.colorIndex])).toEqual([['proj_legacy', 'Legacy', 2]])

    // The next write moves the file to the registry shape, keeping the project.
    await store.add(join(dir, 'second'))
    const written: unknown = JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8'))
    expect(written).toMatchObject({
      projects: [{ id: 'proj_legacy' }, { path: await canonicalizeFolder(join(dir, 'second')) }],
      removed: [],
    })
  })
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore, canonicalizeFolder, resolveProjectAgent } from './projects'
import type { ProjectAgent } from '@ari/contracts/project'

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
  it('persists, clears and restores a project default without changing old registries', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.add(existingFolder)
    expect(project.defaultAgent).toBeUndefined()
    const agent: ProjectAgent = {
      driverKind: 'claude',
      modelId: 'opus',
      effort: 'high',
      permissionMode: 'allow-edits',
    }
    expect((await store.setDefaultAgent(project.id, agent))?.defaultAgent).toEqual(agent)
    const reloaded = new ProjectStore({ dir })
    await reloaded.load()
    expect(reloaded.get(project.id)?.defaultAgent).toEqual(agent)
    await reloaded.remove(project.id)
    expect((await reloaded.add(existingFolder)).defaultAgent).toEqual(agent)
    expect((await reloaded.setDefaultAgent(project.id, null))?.defaultAgent).toBeNull()
    expect(await reloaded.setDefaultAgent('missing', agent)).toBeNull()
  })
  it("seeds a built-in project once, first, and keeps the user's changes to it", async () => {
    const builtIn = { id: 'helm', path: existingFolder, name: 'Aria' }
    const first = new ProjectStore({ dir })
    await first.open(join(dir))
    const seeded = new ProjectStore({ dir, builtIn })
    const listed = await seeded.load()
    expect(listed.map((project) => project.id)[0]).toBe('helm')
    expect(listed[0]).toMatchObject({ name: 'Aria', path: existingFolder, open: true })
    await seeded.close('helm')
    const reloaded = await new ProjectStore({ dir, builtIn }).load()
    expect(reloaded.filter((project) => project.id === 'helm')).toEqual([
      expect.objectContaining({ name: 'Aria', open: false }),
    ])
  })

  it.each(['{corrupt', '{"projects":false}'])(
    'preserves a failed registry read and permits retry: %s',
    async (raw) => {
      const path = join(dir, 'projects.json')
      await writeFile(path, raw)
      const store = new ProjectStore({ dir })
      await expect(store.load()).rejects.toThrow()
      await expect(store.open(existingFolder)).rejects.toThrow()
      await expect(store.remove('unknown')).rejects.toThrow()
      await expect(store.close('unknown')).rejects.toThrow()
      await expect(store.move('unknown', null)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(raw)
      await writeFile(path, '[]')
      expect(await store.load()).toEqual([])
      expect((await store.open(existingFolder)).status).toBe('ok')
    },
  )

  it('reports non-missing read failures without latching an empty registry', async () => {
    const path = join(dir, 'projects.json')
    await mkdir(path)
    const store = new ProjectStore({ dir })
    await expect(store.load()).rejects.toThrow()
    await rm(path, { recursive: true })
    expect(await store.load()).toEqual([])
  })

  it('coalesces boot reads and loads existing projects before adding another', async () => {
    const original = await new ProjectStore({ dir }).open(existingFolder)
    const store = new ProjectStore({ dir })
    const first = store.load()
    expect(store.load()).toBe(first)
    await first
    const cold = new ProjectStore({ dir })
    await cold.open(dir)
    expect(cold.list().map((p) => p.id)).toContain(original.id)
    expect(cold.list()).toHaveLength(2)
  })
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

  it('does not keep a folder that is missing when it is opened', async () => {
    const store = new ProjectStore({ dir })
    const missing = await store.open(join(dir, 'gone'))
    expect(missing.status).toBe('missing')
    expect(store.list()).toEqual([])
    const kept = await store.open(existingFolder)
    await store.close(kept.id)
    await rm(existingFolder, { recursive: true, force: true })
    const again = await store.open(existingFolder)
    expect(again.id).toBe(kept.id)
    expect(again.status).toBe('missing')
    expect(store.list().map((project) => project.id)).toEqual([kept.id])
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
    await mkdir(join(dir, 'open'))
    await mkdir(join(dir, 'other'))
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

describe('project agent resolution', () => {
  const project = { projectId: 'p' }
  const aria = {
    driverKind: 'codex' as const,
    modelId: 'gpt',
    effort: 'medium',
    permissionMode: 'allow-edits' as const,
  }
  const saved = {
    driverKind: 'claude' as const,
    modelId: 'opus',
    effort: 'high',
    permissionMode: 'ask' as const,
  }
  const providers = [
    {
      driverKind: 'claude',
      available: true,
      models: [{ id: 'opus', aliases: ['latest'] }, { id: 'sonnet' }],
      defaultModelId: 'sonnet',
    },
    { driverKind: 'codex', available: true, models: [{ id: 'gpt' }], defaultModelId: 'gpt' },
  ]
  const app = { permissionMode: 'ask' as const }
  const input = { project, aria, providers, app, maxPermissionMode: aria.permissionMode }

  it('takes explicit arguments before the project default, then inherits Aria', () => {
    expect(
      resolveProjectAgent({
        ...input,
        project: { ...project, defaultAgent: saved },
        arguments: { driverKind: 'codex', modelId: 'gpt', effort: 'low' },
      }),
    ).toEqual({ ...aria, effort: 'low', permissionMode: 'ask', source: 'arguments' })
    expect(resolveProjectAgent({ ...input, project: { ...project, defaultAgent: saved } })).toEqual(
      { ...saved, source: 'project' },
    )
    expect(resolveProjectAgent(input)).toEqual({ ...aria, source: 'aria' })
  })

  it('applies partial explicit options to the project choice or Aria', () => {
    expect(
      resolveProjectAgent({
        ...input,
        project: { ...project, defaultAgent: saved },
        arguments: { modelId: 'sonnet', effort: 'low' },
      }),
    ).toEqual({ ...saved, modelId: 'sonnet', effort: 'low', source: 'arguments' })
    expect(resolveProjectAgent({ ...input, arguments: { effort: 'high' } })).toEqual({
      ...aria,
      effort: 'high',
      source: 'arguments',
    })
    expect(
      resolveProjectAgent({
        ...input,
        project: { ...project, defaultAgent: { ...saved, modelId: 'latest' } },
      })?.modelId,
    ).toBe('opus')
  })

  it('caps inherited permissions while leaving explicit elevation visible for refusal', () => {
    const capped = { ...input, maxPermissionMode: 'ask' as const }
    expect(resolveProjectAgent(capped)?.permissionMode).toBe('ask')
    expect(
      resolveProjectAgent({
        ...capped,
        project: { ...project, defaultAgent: { ...saved, permissionMode: 'full' } },
      })?.permissionMode,
    ).toBe('ask')
    expect(
      resolveProjectAgent({ ...capped, arguments: { permissionMode: 'full' } })?.permissionMode,
    ).toBe('full')
  })

  it('uses Aria when the saved model is stale and never chooses another available provider', () => {
    expect(
      resolveProjectAgent({
        ...input,
        project: { ...project, defaultAgent: { ...saved, modelId: 'removed' } },
      }),
    ).toEqual({ ...aria, source: 'aria' })
    expect(resolveProjectAgent({ ...input, aria: { ...aria, modelId: 'removed' } })).toBeNull()
    expect(
      resolveProjectAgent({
        ...input,
        providers: providers.map((p) => ({ ...p, available: p.driverKind === 'claude' })),
      }),
    ).toBeNull()
    expect(resolveProjectAgent({ ...input, aria: { ...aria, modelId: null } })).toEqual({
      ...aria,
      source: 'aria',
    })
  })
})

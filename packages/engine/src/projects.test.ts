import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore, canonicalizeFolder, resolveProjectAgent } from './projects'
import type { ProjectAgent } from '@ari/contracts/project'

const registryWrites = vi.hoisted(() => ({
  started: 0,
  next: null as (() => Promise<void>) | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    mkdir: vi.fn(fs.mkdir),
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('projects.json.tmp')) {
        registryWrites.started++
        const next = registryWrites.next
        registryWrites.next = null
        await next?.()
      }
      return fs.writeFile(...args)
    },
  }
})

function holdRegistryWrite(error?: Error) {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  registryWrites.next = async () => {
    enter()
    await gate
    if (error) throw error
  }
  return { entered, release }
}

let dir: string
let existingFolder: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-projects-'))
  existingFolder = join(dir, 'my-project')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(existingFolder, { recursive: true })
})

afterEach(async () => {
  registryWrites.next = null
  vi.mocked(mkdir).mockReset()
  await rm(dir, { recursive: true, force: true })
})

describe('ProjectStore', () => {
  it('keeps a delayed save ahead of a newer model choice and persists the newest choice', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    const agent: ProjectAgent = {
      driverKind: 'codex',
      modelId: 'older',
      effort: 'high',
      permissionMode: 'full',
    }
    const writesBefore = registryWrites.started
    const held = holdRegistryWrite()
    const older = store.setDefaultAgent(project.id, agent)
    await held.entered
    // The directory already exists. Remove unrelated mkdir I/O from the race
    // so the next runnable write reaches the controlled boundary deterministically.
    vi.mocked(mkdir).mockResolvedValue(undefined)
    const newerAgent = { ...agent, modelId: 'newer', effort: 'xhigh' }
    const newer = store.setDefaultAgent(project.id, newerAgent)
    try {
      await store.load()
      await Promise.resolve()
      expect(store.get(project.id)?.defaultAgent).toEqual(newerAgent)
      expect(registryWrites.started - writesBefore).toBe(1)
    } finally {
      held.release()
      await Promise.all([older, newer])
    }
    const disk = await new ProjectStore({ dir }).load()
    expect(disk.find((entry) => entry.id === project.id)?.defaultAgent).toEqual(newerAgent)
  })

  it('continues queued saves after a write failure without losing later acknowledged changes', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    const previous = await readFile(join(dir, 'projects.json'), 'utf8')
    const failure = new Error('Registry write unavailable')
    const held = holdRegistryWrite(failure)
    const failed = expect(store.close(project.id)).rejects.toThrow(failure.message)
    await held.entered
    const next = store.setDefaultAgent(project.id, {
      driverKind: 'codex',
      modelId: 'selected',
      effort: 'high',
      permissionMode: 'full',
    })
    // Reject the held write before it reaches the real filesystem.
    held.release()
    await failed
    await next
    const disk = await new ProjectStore({ dir }).load()
    expect(disk[0]).toMatchObject({
      id: project.id,
      open: false,
      defaultAgent: { modelId: 'selected' },
    })
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).not.toBe(previous)
  })

  it('persists concurrent project mutations together with removal tombstones', async () => {
    const store = new ProjectStore({ dir })
    const a = await store.open(existingFolder)
    const secondFolder = join(dir, 'second')
    const thirdFolder = join(dir, 'third')
    await mkdir(secondFolder)
    await mkdir(thirdFolder)
    const b = await store.open(secondFolder)
    const c = await store.open(thirdFolder)
    const agent: ProjectAgent = {
      driverKind: 'codex',
      modelId: 'saved',
      effort: 'high',
      permissionMode: 'full',
    }
    const held = holdRegistryWrite()
    const close = store.close(a.id)
    await held.entered
    const mutations = [
      store.setDefaultAgent(b.id, agent),
      store.remove(c.id),
      store.move(b.id, a.id),
    ]
    held.release()
    await Promise.all([close, ...mutations])
    const restarted = new ProjectStore({ dir })
    const disk = await restarted.load()
    expect(disk.map((project) => project.id)).toEqual([b.id, a.id])
    expect(restarted.get(a.id)?.open).toBe(false)
    expect(restarted.get(b.id)?.defaultAgent).toEqual(agent)
    expect(restarted.get(c.id)).toBeNull()
    expect((await restarted.add(thirdFolder)).id).toBe(c.id)
  })

  it('reports regular files and paths through files as unavailable without opening them', async () => {
    const file = join(dir, 'regular-file')
    await writeFile(file, 'not a project directory')
    const store = new ProjectStore({ dir })
    expect((await store.add(file)).status).toBe('missing')
    expect((await store.add(join(file, 'child'))).status).toBe('missing')
    const newFile = join(dir, 'new-file')
    await writeFile(newFile, 'not a project directory')
    expect(await store.open(newFile)).toMatchObject({ status: 'missing', open: false })
    expect(store.list().some((project) => project.path === newFile)).toBe(false)
    expect(store.listOpen()).toEqual([])
  })

  it('recovers an existing project replaced by a file with its identity and saved default intact', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    const agent: ProjectAgent = {
      driverKind: 'codex',
      modelId: 'saved',
      effort: 'xhigh',
      permissionMode: 'full',
    }
    await store.setDefaultAgent(project.id, agent)
    await store.close(project.id)
    await rm(existingFolder, { recursive: true, force: true })
    await writeFile(existingFolder, 'replacement file')
    expect(store.get(project.id)).toMatchObject({ status: 'missing', defaultAgent: agent })
    expect(await store.open(existingFolder)).toMatchObject({
      id: project.id,
      status: 'missing',
      open: false,
    })
    const restarted = new ProjectStore({ dir })
    expect((await restarted.load())[0]).toMatchObject({
      id: project.id,
      status: 'missing',
      defaultAgent: agent,
    })
    await rm(existingFolder)
    await mkdir(existingFolder)
    expect(restarted.get(project.id)).toMatchObject({ status: 'ok', defaultAgent: agent })
    expect(await restarted.open(existingFolder)).toMatchObject({
      id: project.id,
      status: 'ok',
      open: true,
      defaultAgent: agent,
    })
  })

  it('retains a removed project identity and default while its path is a file and later remounts', async () => {
    const store = new ProjectStore({ dir })
    const project = await store.open(existingFolder)
    const agent: ProjectAgent = {
      driverKind: 'codex',
      modelId: 'saved',
      effort: 'high',
      permissionMode: 'full',
    }
    await store.setDefaultAgent(project.id, agent)
    await store.remove(project.id)
    await rm(existingFolder, { recursive: true, force: true })
    await writeFile(existingFolder, 'replacement file')
    const restarted = new ProjectStore({ dir })
    expect(await restarted.load()).toEqual([])
    expect(await restarted.add(existingFolder)).toMatchObject({
      id: project.id,
      status: 'missing',
      defaultAgent: agent,
    })
    await rm(existingFolder)
    await mkdir(existingFolder)
    expect(await restarted.open(existingFolder)).toMatchObject({
      id: project.id,
      status: 'ok',
      defaultAgent: agent,
    })
    expect(restarted.list()).toHaveLength(1)
  })

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
  const saved = {
    driverKind: 'claude' as const,
    modelId: 'opus',
    effort: 'high',
    permissionMode: 'allow-edits' as const,
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
  const input = {
    project,
    providers,
    app: { permissionMode: 'ask' as const },
    maxPermissionMode: 'allow-edits' as const,
  }

  it('uses explicit choices before the saved project default and otherwise requires a user choice', () => {
    expect(
      resolveProjectAgent({
        ...input,
        project: { ...project, defaultAgent: saved },
        arguments: { driverKind: 'codex', modelId: 'gpt', effort: 'low' },
      }),
    ).toEqual({
      driverKind: 'codex',
      modelId: 'gpt',
      effort: 'low',
      permissionMode: 'ask',
      source: 'arguments',
    })
    expect(resolveProjectAgent({ ...input, project: { ...project, defaultAgent: saved } })).toEqual(
      { ...saved, source: 'project' },
    )
    expect(resolveProjectAgent(input)).toBeNull()
    expect(resolveProjectAgent({ ...input, arguments: { driverKind: 'codex' } })).toBeNull()
  })

  it('uses partial options only with a matching saved provider and normalizes model aliases', () => {
    const configured = { ...input, project: { ...project, defaultAgent: saved } }
    expect(
      resolveProjectAgent({ ...configured, arguments: { modelId: 'sonnet', effort: 'low' } }),
    ).toEqual({ ...saved, modelId: 'sonnet', effort: 'low', source: 'arguments' })
    expect(resolveProjectAgent({ ...configured, arguments: { driverKind: 'claude' } })).toEqual({
      ...saved,
      source: 'arguments',
    })
    expect(resolveProjectAgent({ ...input, arguments: { effort: 'high' } })).toBeNull()
    expect(
      resolveProjectAgent({
        ...configured,
        arguments: { driverKind: 'codex', modelId: 'removed' },
      }),
    ).toBeNull()
    expect(resolveProjectAgent({ ...configured, arguments: { driverKind: 'codex' } })).toBeNull()
    expect(resolveProjectAgent({ ...configured, arguments: { modelId: 'latest' } })?.modelId).toBe(
      'opus',
    )
  })

  it('caps saved permissions while leaving explicit elevation visible for refusal', () => {
    const capped = {
      ...input,
      project: { ...project, defaultAgent: { ...saved, permissionMode: 'full' as const } },
      maxPermissionMode: 'ask' as const,
    }
    expect(resolveProjectAgent(capped)?.permissionMode).toBe('ask')
    expect(
      resolveProjectAgent({ ...capped, arguments: { permissionMode: 'full' } })?.permissionMode,
    ).toBe('full')
  })

  it('carries saved effort only onto the same model, including aliases', () => {
    const configured = { ...input, project: { ...project, defaultAgent: saved } }
    for (const provider of [{ driverKind: 'claude' as const }, {}]) {
      expect(
        resolveProjectAgent({ ...configured, arguments: { ...provider, modelId: 'sonnet' } })
          ?.effort,
      ).toBeNull()
      expect(
        resolveProjectAgent({
          ...configured,
          arguments: { ...provider, modelId: 'sonnet', effort: 'low' },
        })?.effort,
      ).toBe('low')
      expect(
        resolveProjectAgent({ ...configured, arguments: { ...provider, modelId: 'latest' } })
          ?.effort,
      ).toBe('high')
      expect(
        resolveProjectAgent({
          ...configured,
          arguments: { ...provider, modelId: 'opus', effort: null },
        })?.effort,
      ).toBeNull()
    }
  })

  it('refuses stale or unset defaults instead of choosing another installed or catalog-default model', () => {
    for (const modelId of ['removed', null])
      expect(
        resolveProjectAgent({
          ...input,
          project: { ...project, defaultAgent: { ...saved, modelId } },
        }),
      ).toBeNull()
    expect(
      resolveProjectAgent({
        ...input,
        project: { ...project, defaultAgent: saved },
        providers: providers.map((p) => ({ ...p, available: p.driverKind === 'codex' })),
      }),
    ).toBeNull()
  })
})

it('moves saved project agents to full auto once, then keeps a later choice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-projects-fullauto-'))
  try {
    const folder = join(dir, 'repo')
    await mkdir(folder)
    const path = join(dir, 'projects.json')
    const agent = { driverKind: 'codex', modelId: 'm', effort: null, permissionMode: 'ask' }
    await writeFile(
      path,
      JSON.stringify({
        projects: [{ id: 'proj_a', name: 'A', path: folder, createdAt: 1, defaultAgent: agent }],
        removed: [],
      }),
    )
    const store = new ProjectStore({ dir })
    await store.load()
    expect(store.get('proj_a')?.defaultAgent?.permissionMode).toBe('full')
    const disk = JSON.parse(await readFile(path, 'utf8')) as {
      fullAutoMigrated?: boolean
      projects: { defaultAgent: { permissionMode: string } }[]
    }
    expect(disk.fullAutoMigrated).toBe(true)

    // Put Ask back by hand: with the marker present it is left alone.
    disk.projects[0]!.defaultAgent.permissionMode = 'ask'
    await writeFile(path, JSON.stringify(disk))
    const restarted = new ProjectStore({ dir })
    await restarted.load()
    expect(restarted.get('proj_a')?.defaultAgent?.permissionMode).toBe('ask')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

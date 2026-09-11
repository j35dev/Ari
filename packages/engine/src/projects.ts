import { dirname } from 'node:path'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { projectSchema } from '@ari/contracts/project'
import type { Project, ProjectStatus, StoredProject } from '@ari/contracts/project'
import { z } from 'zod'
import { newTypedId } from '@ari/shared/ids'

export interface ProjectStoreOptions {
  /** Directory holding projects.json (typically <userData>). */
  dir: string
}

/**
 * Canonical dedupe key for a folder: realpath when it resolves (so symlinks
 * and 8.3 short names collapse), otherwise the absolute path. Case-folded on
 * win32 only, where the filesystem itself is case-insensitive.
 */
export async function canonicalizeFolder(folderPath: string): Promise<string> {
  let absolute = resolve(folderPath)
  try {
    absolute = await realpath(absolute)
  } catch {
    // Missing or unreadable folder: keep the resolved path so a project can
    // still be recorded in the degraded `missing` state.
  }
  return absolute
}

function dedupeKey(canonicalPath: string): string {
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
}

/** Live disk check; never persisted so a remounted folder recovers on reload. */
function diskStatus(folderPath: string): ProjectStatus {
  return existsSync(folderPath) ? 'ok' : 'missing'
}

function withStatus(project: StoredProject): Project {
  return { ...project, status: diskStatus(project.path) }
}

/**
 * A project the user removed. Removal is deliberately not a hard delete:
 * sessions filed under the project keep its id, and a session whose project id
 * resolves to nothing has no workspace at all — no folder to run a turn in, no
 * shell, no explorer. Keeping the record means re-adding the same folder
 * restores the same id, and every one of those sessions comes back with it.
 */
const removedProjectSchema = z.object({
  project: projectSchema,
  removedAt: z.number().int().nonnegative(),
})
type RemovedProject = z.infer<typeof removedProjectSchema>

/**
 * The persisted registry. Older files are a bare `StoredProject[]`; the object
 * wrapper arrived with tombstones, and `load` still accepts both.
 */
const registrySchema = z.object({
  projects: z.array(projectSchema),
  removed: z.array(removedProjectSchema),
})

/**
 * Registered workspace folders. Paths are canonicalized (realpath) before
 * dedupe, so opening the same folder twice reuses its project. A folder that
 * no longer exists is kept and reported with `status: 'missing'` rather than
 * being dropped.
 *
 * Removing a project keeps a tombstone rather than forgetting it outright, so
 * the folder can be added back without stranding the sessions filed under it
 * — see `remove` and `add`.
 */
export class ProjectStore {
  readonly #path: string
  #projects: StoredProject[] = []
  #removed: RemovedProject[] = []
  // Guards against a `load()` racing an in-flight mutation and clobbering it
  // with the on-disk snapshot: the first load wins, later ones are no-ops.
  #loaded = false

  constructor(options: ProjectStoreOptions) {
    this.#path = join(options.dir, 'projects.json')
  }

  async load(): Promise<Project[]> {
    if (this.#loaded) return this.list()
    try {
      const raw = await readFile(this.#path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const legacy = z.array(projectSchema).safeParse(parsed)
      if (legacy.success) {
        this.#projects = legacy.data
      } else {
        const registry = registrySchema.parse(parsed)
        this.#projects = registry.projects
        this.#removed = registry.removed
      }
    } catch {
      this.#projects = []
      this.#removed = []
    }
    this.#loaded = true
    return this.list()
  }

  /** All known projects, each stamped with its live on-disk status. */
  list(): Project[] {
    return this.#projects.map((p) => withStatus(p))
  }

  /** Projects currently occupying a sidebar group. */
  listOpen(): Project[] {
    return this.list().filter((p) => p.open)
  }

  /**
   * Registers a folder (or returns the existing project for the same
   * canonical path). Missing folders are recorded too — the caller sees them
   * as `status: 'missing'`.
   *
   * A folder the user removed earlier comes back as its original project id,
   * so the sessions still filed under that id regain their workspace rather
   * than staying stranded.
   */
  async add(folderPath: string, name?: string): Promise<Project> {
    const canonical = await canonicalizeFolder(folderPath)
    const existing = this.#findByPath(canonical)
    if (existing) return withStatus(existing)
    const tombstone = this.#findRemovedByPath(canonical)
    if (tombstone) {
      const restored: StoredProject = { ...tombstone.project, name: name ?? tombstone.project.name }
      this.#removed = this.#removed.filter((r) => r !== tombstone)
      this.#projects = [...this.#projects, restored]
      await this.#persist()
      return withStatus(restored)
    }
    const project = projectSchema.parse({
      id: newTypedId('proj'),
      name: name ?? canonical.split(/[\\/]/).filter(Boolean).pop() ?? canonical,
      path: canonical,
      colorIndex: this.#projects.length % 8,
      createdAt: Date.now(),
      lastOpenedAt: 0,
      open: false,
    })
    this.#projects = [...this.#projects, project]
    await this.#persist()
    return withStatus(project)
  }

  /**
   * Opens a folder in the sidebar: canonicalizes, reuses the project already
   * registered for that path, and stamps `lastOpenedAt`.
   */
  async open(folderPath: string, name?: string): Promise<Project> {
    const added = await this.add(folderPath, name)
    return (await this.#patch(added.id, { open: true, lastOpenedAt: Date.now() })) ?? added
  }

  /** Closes the sidebar group but keeps the project and its sessions. */
  async close(id: string): Promise<Project | null> {
    return this.#patch(id, { open: false })
  }

  /**
   * Moves a project within the registry — the stored array order *is* the
   * sidebar order. `beforeId` inserts ahead of that project (closed ones
   * included, they are invisible anyway); null appends last. Returns null
   * when either id is unknown, leaving the order untouched.
   */
  async move(id: string, beforeId: string | null): Promise<Project | null> {
    const moved = this.#projects.find((p) => p.id === id)
    if (!moved) return null
    const without = this.#projects.filter((p) => p.id !== id)
    const index =
      beforeId === null ? without.length : without.findIndex((p) => p.id === beforeId)
    if (index === -1) return null
    this.#projects = [...without.slice(0, index), moved, ...without.slice(index)]
    await this.#persist()
    return withStatus(moved)
  }

  /**
   * Leaves the registry — the folder stops being a trusted root and its
   * sessions lose their workspace — but keeps a tombstone, so adding the
   * folder again restores this project's id and revives those sessions.
   */
  async remove(id: string): Promise<boolean> {
    const project = this.#projects.find((p) => p.id === id)
    if (!project) return false
    this.#projects = this.#projects.filter((p) => p.id !== id)
    // One tombstone per folder: `add` dedupes live projects by path, so a
    // second record for the same path can only be a leftover.
    const key = dedupeKey(project.path)
    this.#removed = [
      ...this.#removed.filter((r) => dedupeKey(r.project.path) !== key),
      { project, removedAt: Date.now() },
    ]
    await this.#persist()
    return true
  }

  get(id: string): Project | null {
    const found = this.#projects.find((p) => p.id === id)
    return found ? withStatus(found) : null
  }

  #findByPath(canonicalPath: string): StoredProject | null {
    const key = dedupeKey(canonicalPath)
    return this.#projects.find((p) => dedupeKey(p.path) === key) ?? null
  }

  #findRemovedByPath(canonicalPath: string): RemovedProject | null {
    const key = dedupeKey(canonicalPath)
    return this.#removed.find((r) => dedupeKey(r.project.path) === key) ?? null
  }

  async #patch(id: string, fields: Partial<StoredProject>): Promise<Project | null> {
    const target = this.#projects.find((p) => p.id === id)
    if (!target) return null
    const updated: StoredProject = { ...target, ...fields }
    this.#projects = this.#projects.map((p) => (p.id === id ? updated : p))
    await this.#persist()
    return withStatus(updated)
  }

  async #persist(): Promise<void> {
    const payload = JSON.stringify({ projects: this.#projects, removed: this.#removed }, null, 2)
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.tmp`
    await writeFile(tmp, payload, 'utf8')
    // Windows AV/indexers can hold the target briefly; retry a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(tmp, this.#path)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
      }
    }
    await writeFile(this.#path, payload, 'utf8')
  }
}

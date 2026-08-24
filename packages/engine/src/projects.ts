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
 * Registered workspace folders. Paths are canonicalized (realpath) before
 * dedupe, so opening the same folder twice reuses its project. A folder that
 * no longer exists is kept and reported with `status: 'missing'` rather than
 * being dropped.
 */
export class ProjectStore {
  readonly #path: string
  #projects: StoredProject[] = []

  constructor(options: ProjectStoreOptions) {
    this.#path = join(options.dir, 'projects.json')
  }

  async load(): Promise<Project[]> {
    try {
      const raw = await readFile(this.#path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.#projects = z.array(projectSchema).parse(parsed)
    } catch {
      this.#projects = []
    }
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
   */
  async add(folderPath: string, name?: string): Promise<Project> {
    const canonical = await canonicalizeFolder(folderPath)
    const existing = this.#findByPath(canonical)
    if (existing) return withStatus(existing)
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

  /** Destructive: forgets the project entirely. */
  async remove(id: string): Promise<boolean> {
    const before = this.#projects.length
    this.#projects = this.#projects.filter((p) => p.id !== id)
    if (this.#projects.length === before) return false
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

  async #patch(id: string, fields: Partial<StoredProject>): Promise<Project | null> {
    const target = this.#projects.find((p) => p.id === id)
    if (!target) return null
    const updated: StoredProject = { ...target, ...fields }
    this.#projects = this.#projects.map((p) => (p.id === id ? updated : p))
    await this.#persist()
    return withStatus(updated)
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.tmp`
    await writeFile(tmp, JSON.stringify(this.#projects, null, 2), 'utf8')
    // Windows AV/indexers can hold the target briefly; retry a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(tmp, this.#path)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
      }
    }
    await writeFile(this.#path, JSON.stringify(this.#projects, null, 2), 'utf8')
  }
}

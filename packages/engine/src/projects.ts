import { dirname } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { projectSchema } from '@ari/contracts/project'
import type { Project } from '@ari/contracts/project'
import { z } from 'zod'
import { newTypedId } from '@ari/shared/ids'

export interface ProjectStoreOptions {
  /** Directory holding projects.json (typically <userData>). */
  dir: string
}

/**
 * Registered workspace folders. Paths are validated to exist at add time;
 * missing folders are surfaced (not silently dropped) on load.
 */
export class ProjectStore {
  readonly #path: string
  #projects: Project[] = []

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

  list(): Project[] {
    return [...this.#projects]
  }

  async add(folderPath: string, name?: string): Promise<Project | null> {
    if (!existsSync(folderPath)) return null
    if (this.#projects.some((p) => p.path.toLowerCase() === folderPath.toLowerCase())) {
      return this.#projects.find((p) => p.path.toLowerCase() === folderPath.toLowerCase()) ?? null
    }
    const project: Project = projectSchema.parse({
      id: newTypedId('proj'),
      name: name ?? folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath,
      path: folderPath,
      colorIndex: this.#projects.length % 8,
      createdAt: Date.now(),
    })
    this.#projects = [...this.#projects, project]
    await this.#persist()
    return project
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#projects.length
    this.#projects = this.#projects.filter((p) => p.id !== id)
    if (this.#projects.length === before) return false
    await this.#persist()
    return true
  }

  get(id: string): Project | null {
    return this.#projects.find((p) => p.id === id) ?? null
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

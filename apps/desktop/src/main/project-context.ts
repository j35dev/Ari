import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { HelmProject } from '@ari/contracts/agent-control'
import {
  HELM_DESCRIPTION_CHARS,
  HELM_PROJECT_ID,
  HELM_RECENT_SESSIONS,
  type HelmProjectContext,
} from '@ari/contracts/helm'
import type { SessionListEntry } from '@ari/engine/session-store'

const execFileP = promisify(execFile)
const PREFIX_BYTES = 32 * 1024
const REFRESH_BUDGET_MS = 1_000
const READMES = ['README.md', 'README.mdx', 'README.txt', 'README', 'readme.md']

function short(text: string): string | null {
  const value = text.replace(/\s+/g, ' ').trim()
  return value ? value.slice(0, HELM_DESCRIPTION_CHARS) : null
}

function packageDescription(text: string | null): string | null {
  try {
    const value: unknown = JSON.parse(text ?? '')
    if (value && typeof value === 'object' && 'description' in value)
      return typeof value.description === 'string' ? short(value.description) : null
  } catch {
    // A broken manifest still has a useful README.
  }
  return null
}

function readmeDescription(text: string): string | null {
  const lines = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)
  let fenced = false
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (
      fenced ||
      !line ||
      /^#{1,6}\s|^[=*_-]{3,}$|^</.test(line) ||
      /^[=-]{3,}$/.test(lines[index + 1]?.trim() ?? '') ||
      /^\[?!\[|^\[[^\]]+\]:/.test(line)
    )
      continue
    const prose = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    const description = short(prose)
    if (description) return description
  }
  return null
}

/** Only the repository identity crosses into a prompt; URLs may contain credentials. */
export function repositoryName(remote: string | null): string | null {
  if (!remote) return null
  let path: string
  try {
    if (remote.includes('://')) {
      const url = new URL(remote.trim())
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
      path = url.pathname
    } else {
      const match = /^(?:[^@\s]+@)?[^/:\s]+:(.+)$/.exec(remote.trim())
      if (!match || /^[A-Za-z]:[\\/]/.test(remote)) return null
      path = match[1]!
    }
  } catch {
    return null
  }
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  const name = parts.slice(-2).join('/')
  return parts.length >= 2 && /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null
}

async function originRemote(path: string, signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['config', '--local', '--get', 'remote.origin.url'], {
      cwd: path,
      windowsHide: true,
      timeout: 750,
      maxBuffer: PREFIX_BYTES,
      signal,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

interface CachedFile {
  stamp: string
  text: string | null
}
interface CachedProject {
  path: string
  files: Map<string, CachedFile>
  description: string | null
  repository: string | null
  remoteStamp: string | null
}

/** Background reads only: callers can always take the last completed context synchronously. */
export class ProjectContextCache {
  readonly #projects = new Map<string, CachedProject>()
  readonly #pending = new Map<string, Promise<void>>()

  constructor(readonly readRemote = originRemote) {}

  get(projectId: string): Pick<HelmProjectContext, 'description' | 'repository'> {
    const cached = this.#projects.get(projectId)
    return { description: cached?.description ?? null, repository: cached?.repository ?? null }
  }

  async refresh(projects: readonly Pick<HelmProject, 'projectId' | 'path'>[]): Promise<void> {
    const ids = new Set(projects.map((project) => project.projectId))
    for (const id of this.#projects.keys()) if (!ids.has(id)) this.#projects.delete(id)
    await Promise.all(
      projects
        .filter((project) => project.projectId !== HELM_PROJECT_ID)
        .map(async (project) => {
          if (this.#pending.has(project.projectId)) return
          const controller = new AbortController()
          const work = this.#refresh(project, controller.signal).catch(() => {
            // Unmounted folders and unreadable files leave the last completed context usable.
          })
          this.#pending.set(project.projectId, work)
          const cleanup = (): void => {
            this.#pending.delete(project.projectId)
          }
          void work.finally(cleanup)
          let timer: ReturnType<typeof setTimeout> | undefined
          const budget = new Promise<void>((done) => {
            timer = setTimeout(() => {
              controller.abort()
              done()
            }, REFRESH_BUDGET_MS)
          })
          await Promise.race([work, budget])
          clearTimeout(timer)
        }),
    )
  }

  async #file(cached: CachedProject, path: string, signal: AbortSignal): Promise<CachedFile> {
    signal.throwIfAborted()
    const info = await stat(path).catch((error: unknown) => {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
      throw error
    })
    signal.throwIfAborted()
    const stamp = info?.isFile() ? `${info.mtimeMs}:${info.size}` : 'missing'
    const previous = cached.files.get(path)
    if (previous?.stamp === stamp) return previous
    let text: string | null = null
    if (stamp !== 'missing') {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(PREFIX_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    }
    signal.throwIfAborted()
    const file = { stamp, text }
    cached.files.set(path, file)
    return file
  }

  async #refresh(
    project: Pick<HelmProject, 'projectId' | 'path'>,
    signal: AbortSignal,
  ): Promise<void> {
    let cached = this.#projects.get(project.projectId)
    if (!cached || cached.path !== project.path) {
      cached = {
        path: project.path,
        files: new Map(),
        description: null,
        repository: null,
        remoteStamp: null,
      }
      this.#projects.set(project.projectId, cached)
    }
    const manifest = await this.#file(cached, join(project.path, 'package.json'), signal)
    let description = packageDescription(manifest.text)
    if (!description)
      for (const name of READMES) {
        const readme = await this.#file(cached, join(project.path, name), signal)
        if (readme.text) description = readmeDescription(readme.text)
        if (description) break
      }
    cached.description = description

    let gitDir = join(project.path, '.git')
    const pointer = await this.#file(cached, gitDir, signal)
    if (pointer.text) {
      const target = /^gitdir:\s*(.+)/m.exec(pointer.text)?.[1]?.trim()
      if (!target) {
        cached.repository = null
        return
      }
      gitDir = resolve(project.path, target)
    }
    const common = await this.#file(cached, join(gitDir, 'commondir'), signal)
    const configDir = common.text ? resolve(gitDir, common.text.trim()) : gitDir
    const config = await this.#file(cached, join(configDir, 'config'), signal)
    const worktree = await this.#file(cached, join(gitDir, 'config.worktree'), signal)
    const remoteStamp = `${configDir}:${config.stamp}:${worktree.stamp}`
    if (remoteStamp === cached.remoteStamp) return
    const repository = config.text
      ? repositoryName(await this.readRemote(project.path, signal))
      : null
    signal.throwIfAborted()
    cached.repository = repository
    cached.remoteStamp = remoteStamp
  }
}

/** A selection beats project-open recency; Aria's own selection never replaces it. */
export class ProjectSelection {
  #projectId: string | null = null
  #at = 0

  record(projectId: string, at: number): void {
    if (projectId === HELM_PROJECT_ID || at < this.#at) return
    this.#projectId = projectId
    this.#at = at
  }

  withHistory(
    projects: readonly HelmProject[],
    rows: readonly Pick<SessionListEntry, 'projectId' | 'title' | 'updatedAt' | 'archived'>[],
  ): HelmProject[] {
    const others = projects.filter((project) => project.projectId !== HELM_PROJECT_ID)
    const opened = [...others]
      .filter((project) => (project.lastOpenedAt ?? 0) > 0)
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]
    const selected = others.find((project) => project.projectId === this.#projectId)
    const last = (opened?.lastOpenedAt ?? 0) > this.#at ? opened : (selected ?? opened)
    const recent = [...rows]
      .filter((row) => !row.archived && row.projectId !== HELM_PROJECT_ID)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return projects.map((project) => ({
      ...project,
      lastViewed: project.projectId === last?.projectId,
      recentSessionTitles: recent
        .filter((row) => row.projectId === project.projectId)
        .slice(0, HELM_RECENT_SESSIONS)
        .map((row) => row.title),
    }))
  }
}

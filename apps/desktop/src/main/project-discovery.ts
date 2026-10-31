import type { Dirent } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  agentWorkspaceRecordSchema,
  claudeProjectPathsSchema,
  type DiscoveredProject,
  type ProjectDiscovery,
} from '@ari/contracts/project'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:project-discovery')
const PREFIX_BYTES = 32 * 1024

export interface ProjectDiscoveryOptions {
  homeDir?: string
  claudeHome?: string
  codexHome?: string
  signal?: AbortSignal
  maxFiles?: number
  maxDirectories?: number
  maxEntries?: number
  maxBytes?: number
  maxProjects?: number
}

function pathKey(path: string): string {
  const key = resolve(path).replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function excluded(path: string, roots: ReadonlySet<string>): boolean {
  const key = pathKey(path)
  return (
    /\/(?:\.worktrees|\.git|node_modules|\.ari|\.claude\/worktrees|\.t3\/worktrees)(?:\/|$)/.test(
      key,
    ) || [...roots].some((prefix) => key === prefix || key.startsWith(`${prefix}/`))
  )
}

/** Discovers existing folders from bounded Claude/Codex metadata; never imports or starts agents. */
export async function discoverAgentProjects(
  options: ProjectDiscoveryOptions = {},
): Promise<ProjectDiscovery> {
  const home = options.homeDir ?? homedir()
  const excludedFolders = [join(home, 'Downloads'), join(home, 'Documents', 'Codex')]
  const excludedPaths = new Set(excludedFolders.map(pathKey))
  const signal = options.signal ?? AbortSignal.timeout(8_000)
  const found = new Map<string, DiscoveredProject>()
  const warnings = new Set<string>()
  let files = options.maxFiles ?? 2_000
  let directories = options.maxDirectories ?? 2_000
  let entriesRemaining = options.maxEntries ?? 8_000
  let bytes = options.maxBytes ?? 16 * 1024 * 1024
  const maxProjects = options.maxProjects ?? 100
  let truncated = false
  const stopped = (): boolean => {
    if (signal.aborted || found.size >= maxProjects) {
      truncated = true
      return true
    }
    return false
  }
  const report = (source: string, error: unknown): void => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    warnings.add(`Some ${source} metadata could not be read.`)
    log.warn('project metadata read failed', { source, code: code ?? 'unknown' })
  }
  const prefix = async (path: string, limit: number, source: string): Promise<string | null> => {
    if (stopped()) return null
    if (files <= 0 || bytes <= 0) {
      truncated = true
      return null
    }
    files--
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(path, 'r')
      const info = await handle.stat()
      if (!info.isFile()) return null
      const buffer = Buffer.alloc(Math.min(limit, bytes))
      const read = await handle.read(buffer, 0, buffer.length, 0)
      bytes -= read.bytesRead
      return buffer.subarray(0, read.bytesRead).toString('utf8')
    } catch (error) {
      report(source, error)
      return null
    } finally {
      await handle?.close()
    }
  }
  const add = async (
    path: string,
    source: 'claude' | 'codex',
    at: number | null,
  ): Promise<void> => {
    if (stopped() || !isAbsolute(path) || excluded(path, excludedPaths)) return
    try {
      const canonical = await realpath(path)
      if (excluded(canonical, excludedPaths) || !(await stat(canonical)).isDirectory()) return
      // Linked agent worktrees are not independent projects. Manual browse still accepts them.
      const git = await stat(join(canonical, '.git')).catch(() => null)
      if (git?.isFile()) return
      if (signal.aborted) return
      const key = pathKey(canonical)
      const existing = found.get(key)
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source)
        existing.lastUsedAt = Math.max(existing.lastUsedAt ?? 0, at ?? 0) || null
      } else {
        found.set(key, {
          path: canonical,
          name: basename(canonical) || canonical,
          sources: [source],
          lastUsedAt: at,
        })
      }
    } catch (error) {
      report(source, error)
    }
  }
  const metadata = async (path: string, source: 'claude' | 'codex'): Promise<void> => {
    const text = await prefix(path, PREFIX_BYTES, source)
    if (text === null || signal.aborted) return
    for (const line of text.split('\n').slice(0, 32)) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = agentWorkspaceRecordSchema.safeParse(value)
      if (!parsed.success) continue
      const record = parsed.data
      const origin = record.payload?.source
      if (
        source === 'codex' &&
        record.type === 'session_meta' &&
        typeof origin === 'object' &&
        origin !== null &&
        (Object.hasOwn(origin, 'subagent') || Object.hasOwn(origin, 'subAgent'))
      )
        return
      const cwd = record.cwd || record.payload?.cwd
      if (!cwd) continue
      const info = await stat(path).catch(() => null)
      await add(cwd, source, info?.mtimeMs ?? null)
      return
    }
    if (Buffer.byteLength(text) >= PREFIX_BYTES) truncated = true
  }
  const walk = async (root: string, source: 'claude' | 'codex', depth: number): Promise<void> => {
    if (stopped()) return
    if (directories <= 0 || files <= 0 || bytes <= 0) {
      truncated = true
      return
    }
    directories--
    try {
      // Bound enumeration itself, not just the metadata files opened afterwards.
      const entries: Dirent[] = []
      for await (const entry of await opendir(root)) {
        if (stopped()) break
        if (entriesRemaining <= 0) {
          truncated = true
          break
        }
        entriesRemaining--
        entries.push(entry)
      }
      entries.sort((a, b) => b.name.localeCompare(a.name))
      for (const entry of entries) {
        if (stopped()) break
        if (files <= 0 || bytes <= 0) {
          truncated = true
          break
        }
        const path = join(root, entry.name)
        if (entry.isDirectory() && depth > 0) await walk(path, source, depth - 1)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) await metadata(path, source)
      }
    } catch (error) {
      report(source, error)
    }
  }
  const scan = async (): Promise<void> => {
    // Temp/home aliases and relocated Downloads folders need the same canonical comparison as projects.
    for (const folder of excludedFolders) {
      if (stopped()) return
      try {
        excludedPaths.add(pathKey(await realpath(folder)))
      } catch (error) {
        report('excluded-folder', error)
      }
    }
    const config =
      options.claudeHome && pathKey(options.claudeHome) !== pathKey(join(home, '.claude'))
        ? null
        : await prefix(join(home, '.claude.json'), 1024 * 1024, 'claude')
    if (config !== null) {
      try {
        const parsed = claudeProjectPathsSchema.safeParse(JSON.parse(config))
        if (parsed.success)
          for (const path of Object.keys(parsed.data.projects)) await add(path, 'claude', null)
      } catch {
        warnings.add('Claude’s known-project list could not be read.')
      }
    }
    await walk(join(options.claudeHome ?? join(home, '.claude'), 'projects'), 'claude', 1)
    await walk(join(options.codexHome ?? join(home, '.codex'), 'sessions'), 'codex', 3)
  }
  let stop: (() => void) | undefined
  await Promise.race([
    scan(),
    new Promise<void>((done) => {
      stop = () => {
        truncated = true
        done()
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    }),
  ])
  if (stop) signal.removeEventListener('abort', stop)
  return {
    projects: [...found.values()]
      .map((project) => ({ ...project, sources: [...project.sources] }))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name)),
    truncated,
    warnings: [...warnings],
  }
}

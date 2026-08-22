import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { DEFAULT_IGNORED_NAMES } from '@ari/engine/watcher'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:file-index')

/** Hard ceiling on indexed entries per project (mentions-feed budget). */
export const FILE_INDEX_CAP = 5000

/**
 * Deepest indexed workspace-relative path, in path segments: a file whose
 * relative path has more segments than this is not indexed.
 */
export const FILE_INDEX_MAX_DEPTH = 6

export interface ProjectFileIndexOptions {
  /** Override {@link FILE_INDEX_CAP} (tests). */
  cap?: number
}

interface ListedEntry {
  name: string
  type: 'file' | 'dir'
}

async function listEntries(dir: string): Promise<ListedEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })
  // Same filtering contract as the `fs.list` RPC: only regular files/dirs,
  // so symlinked trees cannot pull listings outside the workspace.
  const listed: ListedEntry[] = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) listed.push({ name: dirent.name, type: 'dir' })
    else if (dirent.isFile()) listed.push({ name: dirent.name, type: 'file' })
  }
  return listed.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  )
}

function depthOf(relativePath: string): number {
  return relativePath.split(/[\\/]+/).filter(Boolean).length
}

function segmentNames(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/).filter(Boolean)
}

const IGNORED_NAMES = new Set<string>(DEFAULT_IGNORED_NAMES)

/** Mirrors the watcher's ignore predicate (see DEFAULT_IGNORED_NAMES). */
function isIgnoredRelative(relativePath: string): boolean {
  const segments = segmentNames(relativePath)
  if (segments.length === 1 && segments[0]?.startsWith('.')) return true
  return segments.some((name) => IGNORED_NAMES.has(name))
}

/**
 * Walks the workspace collecting file paths relative to `rootDir`, depth- and
 * cap-limited, sorted. Skips node_modules/.git/dist-style entries and root
 * dotfiles; symlinks are never followed.
 */
export async function walkWorkspaceFiles(rootDir: string, cap: number): Promise<string[]> {
  const found: string[] = []

  async function visit(dir: string, prefix: string): Promise<void> {
    if (found.length >= cap) return
    for (const entry of await listEntries(dir)) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (isIgnoredRelative(rel)) continue
      if (entry.type === 'file') {
        found.push(rel)
        if (found.length >= cap) return
      } else if (depthOf(rel) < FILE_INDEX_MAX_DEPTH) {
        await visit(join(dir, entry.name), rel)
        if (found.length >= cap) return
      }
    }
  }

  await visit(rootDir, '')
  return found.sort((a, b) => a.localeCompare(b))
}

/**
 * In-memory per-project file listing fed by the workspace watcher: an initial
 * full walk on start, then incremental add/remove from debounced change
 * batches. Paths are stored workspace-relative and capped at
 * {@link FILE_INDEX_CAP}.
 *
 * Batches arriving before the initial walk completes are buffered and applied
 * afterwards, so no delta between watch start and walk end is lost.
 */
export class ProjectFileIndex {
  readonly #rootDir: string
  readonly #cap: number
  readonly #paths = new Set<string>()
  readonly #pendingBatches: string[][] = []
  #initialized = false

  constructor(rootDir: string, options: ProjectFileIndexOptions = {}) {
    this.#rootDir = rootDir
    this.#cap = Math.max(1, options.cap ?? FILE_INDEX_CAP)
  }

  /** Number of indexed paths. */
  get size(): number {
    return this.#paths.size
  }

  /** Builds the initial full listing. Safe to call once; later calls re-walk. */
  async init(): Promise<void> {
    const found = await walkWorkspaceFiles(this.#rootDir, this.#cap)
    this.#paths.clear()
    for (const path of found) this.#paths.add(this.#normalize(path))
    log.debug('file index built', { rootDir: this.#rootDir, entries: this.#paths.size })
    this.#initialized = true
    const pending = this.#pendingBatches.splice(0)
    for (const batch of pending) await this.applyBatch(batch)
  }

  /** Snapshot of the index, sorted. */
  paths(): string[] {
    return [...this.#paths].sort((a, b) => a.localeCompare(b))
  }

  /**
   * Applies a debounced batch of absolute changed paths. Entries inside the
   * workspace that still exist as files are added; missing ones are removed.
   * Never throws — stat failures are treated as removals.
   */
  async applyBatch(absolutePaths: readonly string[]): Promise<void> {
    if (!this.#initialized) {
      this.#pendingBatches.push([...absolutePaths])
      return
    }
    for (const absolute of absolutePaths) {
      const rel = relative(this.#rootDir, absolute)
      if (!this.#isIndexable(rel)) continue
      const exists = await stat(absolute).then(
        (info) => info.isFile(),
        () => false,
      )
      if (exists) this.#add(rel)
      else this.#paths.delete(this.#normalize(rel))
    }
  }

  /**
   * Stored form of a relative path: forward slashes so walk- and
   * watcher-sourced entries share one representation.
   */
  #normalize(rel: string): string {
    return rel.replaceAll('\\', '/')
  }

  #isIndexable(rel: string): boolean {
    if (rel === '') return false
    const segments = segmentNames(rel)
    if (segments[0] === '..' || isAbsolute(rel)) return false
    if (segments.length > FILE_INDEX_MAX_DEPTH) return false
    return !isIgnoredRelative(rel)
  }

  #add(rel: string): void {
    const normalized = this.#normalize(rel)
    if (this.#paths.size >= this.#cap && !this.#paths.has(normalized)) {
      log.debug('file index cap reached; dropping', { rootDir: this.#rootDir, path: rel })
      return
    }
    this.#paths.add(normalized)
  }
}

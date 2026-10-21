import { resolve } from 'node:path'
import { WorkspaceWatcher } from '@ari/engine/watcher'
import { createLogger } from '@ari/shared/logger'
import { ProjectFileIndex } from './file-index'

const log = createLogger('desktop:watcher-bridge')

/** Minimal project shape needed to watch a workspace and index its files. */
export interface WatchedProject {
  id: string
  path: string
}

/**
 * One WorkspaceWatcher per project root, created lazily; keys are normalized
 * (lower-cased on win32, matching ProjectStore). Exposed via
 * {@link getWatcherRegistry} in ./store.
 */
export const watchers = new Map<string, WorkspaceWatcher>()

/** Per-project file index fed by the watchers; keyed by project id. */
const indexes = new Map<string, ProjectFileIndex>()
/** Each index's initial walk, settled once it is done (or failed). */
const builds = new Map<string, Promise<void>>()

function keyFor(projectPath: string): string {
  const absolute = resolve(projectPath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** True when two paths name the same folder under the platform's case rules. */
export function sameRoot(a: string, b: string): boolean {
  return keyFor(a) === keyFor(b)
}

function handleChange(paths: string[]): void {
  for (const index of indexes.values()) void index.applyBatch(paths)
}

export interface WatcherOptions {
  /** Override the change-batching window (tests). */
  debounceMs?: number
}

export function getWatcher(projectPath: string, options: WatcherOptions = {}): WorkspaceWatcher {
  const key = keyFor(projectPath)
  const existing = watchers.get(key)
  if (existing) return existing
  const watcher = new WorkspaceWatcher({
    events: { onChange: handleChange },
    debounceMs: options.debounceMs,
  })
  watcher.watch(projectPath)
  watchers.set(key, watcher)
  log.info('workspace watcher started', { projectPath })
  return watcher
}

/**
 * Lazily starts the watcher + file index for a project. Idempotent per
 * project id and per path; never throws. The index is built from a full walk
 * before this resolves; change batches that land during the walk are applied
 * once it finishes.
 */
export async function ensureProjectWatched(
  project: WatchedProject,
  options: WatcherOptions = {},
): Promise<void> {
  // Watch first so no change slips past the initial walk: batches landing
  // before the index finishes building are buffered inside the index.
  getWatcher(project.path, options)
  if (!indexes.has(project.id)) {
    const index = new ProjectFileIndex(project.path)
    indexes.set(project.id, index)
    builds.set(
      project.id,
      index.init().catch((error: unknown) => log.error('file index build failed', error)),
    )
  }
  await builds.get(project.id)
}

/** Indexed workspace-relative paths for a project, or null if none built. */
export function getIndexedFiles(projectId: string): string[] | null {
  return indexes.get(projectId)?.paths() ?? null
}

/**
 * Indexed paths of a project that is already being watched, once its initial
 * walk is done; null when nothing watches it. Never starts a watcher.
 */
export async function watchedFiles(projectId: string): Promise<string[] | null> {
  const build = builds.get(projectId)
  if (build === undefined) return null
  await build
  return getIndexedFiles(projectId)
}

/**
 * Drops a removed project's file index and stops its watcher. Without this
 * the folder keeps being watched and indexed for the rest of the process.
 * Idempotent; safe when nothing was ever watching.
 */
export async function stopWatchingProject(projectPath: string, projectId?: string): Promise<void> {
  if (projectId) {
    indexes.delete(projectId)
    builds.delete(projectId)
  }
  const watcher = watchers.get(keyFor(projectPath))
  if (!watcher) return
  watchers.delete(keyFor(projectPath))
  await watcher.close()
  log.info('workspace watcher stopped', { projectPath })
}

/** Shuts down every project watcher and clears all indexes. Idempotent. */
export async function closeAllWatchers(): Promise<void> {
  const all = [...watchers.values()]
  watchers.clear()
  indexes.clear()
  builds.clear()
  await Promise.all(all.map((watcher) => watcher.close()))
}

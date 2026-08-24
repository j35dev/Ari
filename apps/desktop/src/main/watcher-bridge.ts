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

function keyFor(projectPath: string): string {
  const absolute = resolve(projectPath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
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
    try {
      await index.init()
    } catch (error) {
      log.error('file index build failed', error)
    }
  }
}

/** Indexed workspace-relative paths for a project, or null if none built. */
/** Indexed workspace-relative paths for a project, or null if none built. */
export function getIndexedFiles(projectId: string): string[] | null {
  return indexes.get(projectId)?.paths() ?? null
}

/**
 * Drops a removed project's file index and stops its watcher. Without this
 * the folder keeps being watched and indexed for the rest of the process.
 * Idempotent; safe when nothing was ever watching.
 */
export async function stopWatchingProject(projectPath: string, projectId?: string): Promise<void> {
  if (projectId) indexes.delete(projectId)
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
  await Promise.all(all.map((watcher) => watcher.close()))
}

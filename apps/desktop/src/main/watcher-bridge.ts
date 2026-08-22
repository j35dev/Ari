import { resolve } from 'node:path'
import { WorkspaceWatcher } from '@ari/engine/watcher'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:watcher-bridge')

/**
 * One WorkspaceWatcher per open project, created lazily. Events are logged for
 * now; RPC wiring lands with mentions indexing (M9.6).
 */
const watchers = new Map<string, WorkspaceWatcher>()

function keyFor(projectPath: string): string {
  const absolute = resolve(projectPath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function getWatcher(projectPath: string): WorkspaceWatcher {
  const key = keyFor(projectPath)
  const existing = watchers.get(key)
  if (existing) return existing
  const watcher = new WorkspaceWatcher({
    events: {
      onChange: (paths) => log.debug('workspace changes', { projectPath, paths }),
    },
  })
  watcher.watch(projectPath)
  watchers.set(key, watcher)
  log.info('workspace watcher started', { projectPath })
  return watcher
}

/** Shuts down every project watcher (app quit / tests). Idempotent. */
export async function closeAllWatchers(): Promise<void> {
  const all = [...watchers.values()]
  watchers.clear()
  await Promise.all(all.map((watcher) => watcher.close()))
}

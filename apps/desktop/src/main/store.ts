import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { EndpointStore } from '@ari/ari-core/endpoints'
import type { WorkspaceWatcher } from '@ari/engine/watcher'
import { ProjectStore } from '@ari/engine/projects'
import { SessionStore } from '@ari/engine/session-store'
import { SettingsStore } from '@ari/engine/settings'
import { createLogger } from '@ari/shared/logger'
import { migrateLegacyPlaintextKeys, resolveSecretBox } from './secret-box'
import { watchers } from './watcher-bridge'

const log = createLogger('desktop:store')

let sessionStore: SessionStore | null = null
let settingsStore: SettingsStore | null = null
let projectStore: ProjectStore | null = null
let endpointStore: EndpointStore | null = null

/** Root for all per-session journals: <userData>/sessions/<sessionId>/. */
export function sessionsRoot(): string {
  return join(app.getPath('userData'), 'sessions')
}

/**
 * Singleton registry of per-project workspace watchers, keyed by normalized
 * project path. Managed by ./watcher-bridge.
 */
export function getWatcherRegistry(): Map<string, WorkspaceWatcher> {
  return watchers
}

export function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = new SessionStore({ rootDir: sessionsRoot() })
    log.info('session store ready', { rootDir: sessionsRoot() })
  }
  return sessionStore
}

export function getSettingsStore(): SettingsStore {
  if (!settingsStore) {
    settingsStore = new SettingsStore({ dir: app.getPath('userData') })
  }
  return settingsStore
}

export function getProjectStore(): ProjectStore {
  if (!projectStore) {
    projectStore = new ProjectStore({ dir: app.getPath('userData') })
  }
  return projectStore
}

export function getEndpointStore(): EndpointStore {
  if (!endpointStore) {
    // Keys encrypt via the OS keyring (safeStorage), falling back to an
    // AES-GCM key file on headless machines; pre-encryption plaintext files
    // are rewritten once here so existing users keep working.
    const dir = join(app.getPath('userData'), 'ari-core')
    const box = resolveSecretBox({
      storage: safeStorage,
      keyDir: join(app.getPath('userData'), 'secrets'),
    })
    if (migrateLegacyPlaintextKeys(join(dir, 'endpoints.json'), box)) {
      log.info('migrated legacy plaintext endpoint keys to encrypted form')
    }
    endpointStore = new EndpointStore({ dir, secretBox: box })
  }
  return endpointStore
}

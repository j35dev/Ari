import { join } from 'node:path'
import { app } from 'electron'
import { ProjectStore } from '@ari/engine/projects'
import { SessionStore } from '@ari/engine/session-store'
import { SettingsStore } from '@ari/engine/settings'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:store')

let sessionStore: SessionStore | null = null
let settingsStore: SettingsStore | null = null
let projectStore: ProjectStore | null = null

/** Root for all per-session journals: <userData>/sessions/<sessionId>/. */
export function sessionsRoot(): string {
  return join(app.getPath('userData'), 'sessions')
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

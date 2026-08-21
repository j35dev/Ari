import { join } from 'node:path'
import { app } from 'electron'
import { SessionStore } from '@ari/engine/session-store'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:store')

let sessionStore: SessionStore | null = null

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

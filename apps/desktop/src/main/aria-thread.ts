import { isHelmSession, HELM_PROJECT_ID } from '@ari/contracts/helm'
import { DEFAULT_SESSION_TITLE } from '@ari/engine/title'
import type { SessionCreateParams, SessionSummary } from '@ari/contracts/rpc'
import type { Settings } from '@ari/contracts/settings'
import { createSession, type SessionCreateDeps } from './session-create'

type AriaPick = Omit<SessionCreateParams, 'projectId' | 'title' | 'lead'>

export interface AriaThreadDeps extends SessionCreateDeps {
  listSessions: () => Promise<SessionSummary[]>
  archive: (sessionId: string) => Promise<void>
  settings: () => Promise<Settings>
  defaults: () => Promise<AriaPick>
}

// All windows share the same journal: concurrent opens must not create two topics.
let writes: Promise<unknown> = Promise.resolve()

export class AriaThread {
  constructor(private readonly deps: AriaThreadDeps) {}

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writes.then(operation)
    writes = result.catch(() => undefined)
    return result
  }

  private async current(): Promise<SessionSummary | undefined> {
    return (await this.deps.listSessions())
      .filter((session) => isHelmSession(session) && !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  private async create(pick: AriaPick | undefined): Promise<{ sessionId: string }> {
    const settings = await this.deps.settings()
    const defaults = settings.aria ?? pick ?? (await this.deps.defaults())
    return createSession(this.deps, {
      ...defaults,
      permissionMode: settings.aria?.permissionMode ?? settings.sessions.defaultPermissionMode,
      projectId: HELM_PROJECT_ID,
      // Topics keep automatic titles for history; the visible identity stays Aria.
      title: DEFAULT_SESSION_TITLE,
    })
  }

  open(pick?: AriaPick): Promise<{ sessionId: string }> {
    return this.queue(async () => {
      const current = await this.current()
      return current ? { sessionId: current.id } : this.create(pick)
    })
  }

  newTopic(pick?: AriaPick): Promise<{ sessionId: string }> {
    return this.queue(async () => {
      const current = await this.current()
      if (current) await this.deps.archive(current.id)
      return this.create(pick)
    })
  }

  topics(): Promise<SessionSummary[]> {
    return this.queue(async () => {
      const current = await this.current()
      return (await this.deps.listSessions())
        .filter((session) => isHelmSession(session) && session.id !== current?.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    })
  }
}

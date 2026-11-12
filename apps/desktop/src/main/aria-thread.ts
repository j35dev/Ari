import { isHelmSession, HELM_PROJECT_ID } from '@ari/contracts/helm'
import { DEFAULT_SESSION_TITLE } from '@ari/engine/title'
import type { SessionCreateParams, SessionSummary } from '@ari/contracts/rpc'
import type { Settings } from '@ari/contracts/settings'
import type { Session } from '@ari/contracts/session'
import { createSession, type SessionCreateDeps } from './session-create'

type AriaPick = Omit<SessionCreateParams, 'projectId' | 'title' | 'lead'>

export interface AriaThreadDeps extends SessionCreateDeps {
  listSessions: () => Promise<SessionSummary[]>
  loadSession: (sessionId: string) => Promise<Session | null>
  destroySession: (sessionId: string) => Promise<unknown>
  settings: () => Promise<Settings>
  defaults: () => Promise<AriaPick>
}

// All windows share the same journal: concurrent opens must not create two chats.
let writes: Promise<unknown> = Promise.resolve()

export class AriaThread {
  constructor(private readonly deps: AriaThreadDeps) {}

  private async requireEnabled(): Promise<void> {
    if (!(await this.deps.settings()).experimental.ariaEnabled)
      throw new Error('Aria is off. Enable it in Settings → Experimental.')
  }

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
    if (!settings.experimental.ariaEnabled)
      throw new Error('Aria is off. Enable it in Settings → Experimental.')
    const defaults = pick ?? (await this.deps.defaults())
    return createSession(this.deps, {
      ...defaults,
      permissionMode: settings.sessions.defaultPermissionMode,
      projectId: HELM_PROJECT_ID,
      title: DEFAULT_SESSION_TITLE,
    })
  }

  open(pick?: AriaPick): Promise<{ sessionId: string }> {
    return this.queue(async () => {
      await this.requireEnabled()
      const current = await this.current()
      await this.requireEnabled()
      return current ? { sessionId: current.id } : this.create(pick)
    })
  }

  newChat(): Promise<{ sessionId: string }> {
    return this.queue(async () => {
      await this.requireEnabled()
      const current = await this.current()
      if (!current) return this.create(undefined)
      const session = await this.deps.loadSession(current.id)
      if (!session) throw new Error('Could not load the current Aria chat.')
      await this.requireEnabled()
      await this.deps.destroySession(current.id)
      return createSession(this.deps, {
        projectId: HELM_PROJECT_ID,
        title: DEFAULT_SESSION_TITLE,
        driverKind: session.driverKind,
        modelId: session.modelId,
        effort: session.effort,
        permissionMode: session.permissionMode,
      })
    })
  }
}

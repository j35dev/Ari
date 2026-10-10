import type { JournalEvent } from '@ari/contracts/events'
import type { SessionStore } from '@ari/engine/session-store'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:notifier')

export interface SessionNotice {
  title: string
  body: string
}

export interface NoticeContext {
  /** The session's current title. */
  title: string
  /** True for a delegated child: its parent is the one the user is following. */
  isChild: boolean
  /** Children of this session that are still mid-turn. */
  liveChildren: number
}

const BODY_CHARS = 180

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_CHARS ? `${flat.slice(0, BODY_CHARS - 1)}…` : flat
}

/**
 * What, if anything, is worth interrupting the user for. A blocked session is
 * always worth it, whoever owns it, because the whole tree waits on that
 * answer. A finished turn is only news when the work is: a child reports to
 * its parent, and a parent that ended its turn while children still run will
 * be woken again when they finish.
 */
export function sessionNotice(event: JournalEvent, context: NoticeContext): SessionNotice | null {
  switch (event.type) {
    case 'approval.requested':
      return { title: `${context.title} needs your approval`, body: oneLine(event.toolName) }
    case 'input.requested':
      return { title: `${context.title} has a question`, body: oneLine(event.prompt) }
    case 'turn.settled':
      if (event.stopReason === 'error')
        return {
          title: `${context.title} failed`,
          body: oneLine(event.errorMessage ?? 'The turn ended with an error.'),
        }
      if (event.stopReason !== 'completed' || context.isChild || context.liveChildren > 0)
        return null
      return { title: `${context.title} finished`, body: 'The turn is complete.' }
    default:
      return null
  }
}

export interface SessionNotifierOptions {
  store: Pick<SessionStore, 'load' | 'listSessions'>
  /** The user's setting; read at each event so a toggle applies immediately. */
  enabled(): boolean
  /** True while the user is looking at Ari, where the app already shows all of this. */
  focused(): boolean
  show(sessionId: string, notice: SessionNotice): void
}

/** Turns journal events into OS notifications while Ari is in the background. */
export class SessionNotifier {
  constructor(readonly options: SessionNotifierOptions) {}

  /** Fire-and-forget: a notification must never hold up or fail the event flow. */
  observe(sessionId: string, event: JournalEvent): void {
    if (
      event.type !== 'turn.settled' &&
      event.type !== 'approval.requested' &&
      event.type !== 'input.requested'
    )
      return
    if (!this.options.enabled() || this.options.focused()) return
    void this.#notify(sessionId, event).catch((error: unknown) => {
      log.warn('session notification failed', { error: String(error) })
    })
  }

  async #notify(sessionId: string, event: JournalEvent): Promise<void> {
    const { session } = await this.options.store.load(sessionId)
    if (!session) return
    let liveChildren = 0
    if (event.type === 'turn.settled' && event.stopReason === 'completed')
      for (const row of await this.options.store.listSessions())
        if (
          row.parentSessionId === sessionId &&
          (await this.options.store.load(row.id)).activeTurnId !== null
        )
          liveChildren++
    const notice = sessionNotice(event, {
      title: session.title,
      isChild: Boolean(session.parentSessionId),
      liveChildren,
    })
    if (notice) this.options.show(sessionId, notice)
  }
}

import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { Session } from '@ari/contracts/session'
import { decideCommand } from '@ari/engine/dispatcher'
import type { DispatchIds } from '@ari/engine/dispatcher'
import type { UnstampedEvent } from '@ari/engine/projection'
import type { SessionStore } from '@ari/engine/session-store'
import { newTypedId } from '@ari/shared/ids'
import { createLogger } from '@ari/shared/logger'
import type { DriverRegistry } from '@ari/providers/registry'

const log = createLogger('desktop:engine')

export interface EngineDeps {
  store: SessionStore
  registry: DriverRegistry
  /** Delivers a journal event to live subscribers of that session. */
  publish: (sessionId: string, event: JournalEvent) => void
}

interface ActiveTurn {
  sessionId: string
  turnId: string
  interrupt: () => void
}

/**
 * The session engine: validates commands through the pure decider, persists
 * the decided events to journals, executes provider side effects, and
 * streams every appended event to subscribers.
 */
export class Engine {
  readonly #deps: EngineDeps
  readonly #activeTurns = new Map<string, ActiveTurn>()

  constructor(deps: EngineDeps) {
    this.#deps = deps
  }

  async dispatch(command: Command): Promise<{ accepted: boolean; reason?: string }> {
    if (!('sessionId' in command)) {
      return { accepted: false, reason: 'session.create is handled by the store' }
    }
    const model = await this.#deps.store.load(command.sessionId)
    const ids: DispatchIds = {
      turnId: newTypedId('turn'),
      messageId: newTypedId('msg'),
    }
    const decision = decideCommand(model, command, ids)
    if (!decision.accepted) {
      return { accepted: false, reason: decision.reason }
    }

    for (const event of decision.events) {
      await this.#append(command.sessionId, event)
    }

    if (command.type === 'turn.start') {
      void this.#runTurn(model.session as Session, command.text, ids.turnId).catch((e) => {
        log.error('turn execution crashed', { error: String(e) })
      })
    }

    if (command.type === 'turn.interrupt') {
      this.#activeTurns.get(command.sessionId)?.interrupt()
    }

    return { accepted: true }
  }

  async #append(sessionId: string, event: UnstampedEvent): Promise<JournalEvent> {
    const stamped = await this.#deps.store.append(sessionId, event)
    this.#deps.publish(sessionId, stamped)
    return stamped
  }

  /**
   * Runs one provider turn: spawns the adapter, maps normalized agent events
   * into journal parts (coalescing text), and settles the turn.
   */
  async #runTurn(session: Session, prompt: string, turnId: string): Promise<void> {
    const driver = this.#deps.registry.get(session.driverKind)
    if (!driver) {
      await this.#settle(session.id, turnId, 'error', `no driver registered for ${session.driverKind}`)
      return
    }

    // Bracket the turn with a checkpoint when the workspace is a git repo
    // (PLAN §3). captureCheckpoint returns null outside repos; failures are
    // non-fatal — checkpoints are best-effort.
    const workspacePath = session.projectId === 'adhoc' ? process.cwd() : session.projectId
    const { GitService } = await import('@ari/engine/git')
    const captured = await new GitService().captureCheckpoint(workspacePath, session.id, turnId)
    if (captured.ok && captured.value !== null) {
      await this.#append(session.id, {
        type: 'checkpoint.captured',
        turnId,
        gitRef: captured.value,
      })
    }

    let adapter
    try {
      adapter = await driver.create({
        sessionId: session.id,
        workspacePath,
        prompt,
        modelId: session.modelId,
        permissionMode: session.permissionMode,
        resumeOf: null,
      })
    } catch (e) {
      await this.#settle(session.id, turnId, 'error', String(e))
      return
    }

    let interrupted = false
    this.#activeTurns.set(session.id, {
      sessionId: session.id,
      turnId,
      interrupt: () => {
        interrupted = true
        adapter.interrupt()
      },
    })

    // Coalesced part buffer: text/thinking flush at ~120ms or on non-text.
    let buffer: { type: 'text' | 'thinking'; text: string }[] = []
    let lastFlush = Date.now()
    const messageId = newTypedId('msg')

    // Post-interrupt guard: the decider already settled an interrupted turn;
    // late adapter events must never overwrite that state.
    const append = async (event: UnstampedEvent): Promise<void> => {
      if (interrupted) return
      await this.#append(session.id, event)
    }

    const flush = async (): Promise<void> => {
      if (buffer.length === 0 || interrupted) {
        buffer = []
        return
      }
      const parts = buffer.map((b) => ({ type: b.type, text: b.text }) as const)
      buffer = []
      lastFlush = Date.now()
      await this.#append(session.id, {
        type: 'assistant.parts.appended',
        messageId,
        parts,
      })
    }

    try {
      for await (const event of adapter.start()) {
        switch (event.type) {
          case 'text-delta':
          case 'thinking-delta': {
            buffer.push({ type: event.type === 'text-delta' ? 'text' : 'thinking', text: event.text })
            if (Date.now() - lastFlush >= 120) await flush()
            break
          }
          case 'tool-started': {
            await flush()
            // Tool calls attach to the same streaming assistant message.
            await append({
              type: 'assistant.parts.appended',
              messageId,
              parts: [
                { type: 'tool-call', callId: event.callId, name: event.name, argsJson: event.argsJson },
              ],
            })
            break
          }
          case 'tool-completed': {
            await flush()
            await append({
              type: 'assistant.parts.appended',
              messageId,
              parts: [
                {
                  type: 'tool-result',
                  callId: event.callId,
                  resultJson: event.resultJson,
                  isError: event.isError,
                },
              ],
            })
            break
          }
          case 'usage': {
            await append({
              type: 'usage.recorded',
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
            })
            break
          }
          case 'status':
            await append({
              type: 'session.status.changed',
              from: session.status,
              to: event.status,
              reason: null,
            })
            break
          case 'approval-requested':
            await append({
              type: 'approval.requested',
              approvalId: event.approvalId,
              toolName: event.toolName,
              summaryJson: event.summaryJson,
            })
            break
          case 'input-requested':
            // Question panel arrives in M7; surface as an error-free notice.
            log.info('provider requested input', { sessionId: session.id })
            break
          case 'error':
            await append({
              type: 'assistant.parts.appended',
              messageId,
              parts: [{ type: 'text', text: `\n\n⚠ ${event.message}` }],
            })
            break
          case 'done':
            break
        }
      }
      await flush()
      if (!interrupted) await this.#settle(session.id, turnId, 'completed', null)
    } catch (e) {
      await flush().catch(() => undefined)
      if (!interrupted) await this.#settle(session.id, turnId, 'error', String(e))
    } finally {
      this.#activeTurns.delete(session.id)
      void adapter.dispose()
    }
  }

  async #settle(
    sessionId: string,
    turnId: string,
    stopReason: 'completed' | 'interrupted' | 'error',
    errorMessage: string | null,
  ): Promise<void> {
    const model = await this.#deps.store.load(sessionId)
    await this.#append(sessionId, {
      type: 'turn.settled',
      turnId,
      stopReason,
      errorMessage,
    })
    if (model.status !== 'idle') {
      await this.#append(sessionId, {
        type: 'session.status.changed',
        from: model.status === 'unknown' ? 'idle' : model.status,
        to: stopReason === 'error' ? 'error' : 'idle',
        reason: errorMessage,
      })
    }
  }

  /** Live tail: replays the journal, then forwards appended events. */
  async replaySession(sessionId: string): Promise<JournalEvent[]> {
    const journal = await this.#deps.store.openJournal(sessionId)
    const entries = await journal.readAll()
    return entries.flatMap((e) => (e.kind === 'value' ? [e.value] : []))
  }
}

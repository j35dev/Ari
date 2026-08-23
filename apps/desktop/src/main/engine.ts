import { existsSync } from 'node:fs'
import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { Session } from '@ari/contracts/session'
import { decideCommand } from '@ari/engine/dispatcher'
import type { DispatchIds } from '@ari/engine/dispatcher'
import type { UnstampedEvent } from '@ari/engine/projection'
import type { SessionStore } from '@ari/engine/session-store'
import { deterministicTitleStrategy, isAutoTitle } from '@ari/engine/title'
import type { TitleStrategy } from '@ari/engine/title'
import { newTypedId } from '@ari/shared/ids'
import { createLogger } from '@ari/shared/logger'
import type { DriverRegistry } from '@ari/providers/registry'
import type { AdapterApprovalDecision } from '@ari/providers/driver'

const log = createLogger('desktop:engine')

export interface CheckpointCapturer {
  captureCheckpoint(
    cwd: string,
    sessionId: string,
    turnId: string,
  ): Promise<{ ok: true; value: string | null } | { ok: false; error: { message: string } }>
  /**
   * Best-effort GC of hidden checkpoint refs, keeping the newest
   * `maxPerSession` per session. Returns the deleted refs. Optional so
   * test doubles can omit it.
   */
  pruneCheckpoints?(
    cwd: string,
    sessionId: string,
    maxPerSession: number,
  ): Promise<{ ok: true; value: string[] } | { ok: false; error: { message: string } }>
}

/** Upper bound on stored checkpoints per session before oldest are pruned. */
const MAX_CHECKPOINTS_PER_SESSION = 50

export interface EngineDeps {
  store: SessionStore
  registry: DriverRegistry
  /** Delivers a journal event to live subscribers of that session. */
  publish: (sessionId: string, event: JournalEvent) => void
  /** Checkpoint source; defaults to the real GitService. */
  git?: CheckpointCapturer
  /**
   * Maps a session's projectId to a workspace folder. Absent for tests: the
   * legacy fallback treats 'adhoc' as process.cwd() and any other id as a
   * literal path.
   */
  resolveWorkspace?: (projectId: string) => Promise<string | null>
  /**
   * Upgrades the auto-slice title after the first settled turn (M18.2).
   * Defaults to the deterministic strategy; an LLM-backed one can be
   * injected without touching the turn flow. Failures never surface.
   */
  titleStrategy?: TitleStrategy
}

interface ActiveTurn {
  sessionId: string
  turnId: string
  interrupt: () => void
  /** Forwards approval decisions into the live adapter (M16.8). */
  respondApproval: (approvalId: string, decision: AdapterApprovalDecision) => void
  /** Forwards mid-turn steering text into the live adapter (M17.1). */
  steer: (text: string) => void
}

/**
 * The session engine: validates commands through the pure decider, persists
 * the decided events to journals, executes provider side effects, and
 * streams every appended event to subscribers.
 */
export class Engine {
  readonly #deps: EngineDeps
  readonly #activeTurns = new Map<string, ActiveTurn>()
  /** Sessions whose first non-error settle already ran title generation. */
  readonly #titleSettled = new Set<string>()

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
      void this.#runTurn(
        model.session as Session,
        command.text,
        ids.turnId,
        model.providerSessionId,
      ).catch((e) => {
        log.error('turn execution crashed', { error: String(e) })
      })
    }

    if (command.type === 'turn.interrupt') {
      this.#activeTurns.get(command.sessionId)?.interrupt()
      this.#onFirstSettle(command.sessionId)
    }

    if (command.type === 'approval.respond') {
      // Route the decision to the live adapter so in-band approval protocols
      // (claude stdin control, ACP request_permission) actually proceed —
      // previously the decision was only journaled and the provider hung.
      this.#activeTurns
        .get(command.sessionId)
        ?.respondApproval(command.approvalId, command.decision)
    }

    if (command.type === 'message.enqueue') {
      // A user message arriving behind a running turn steers that turn in
      // providers with a writable control channel (claude stdin, ACP);
      // transports without one simply queue it for the next turn.
      this.#activeTurns.get(command.sessionId)?.steer(command.text)
    }

    if (command.type === 'checkpoint.revert') {
      const ref = model.checkpoints.find((c) => c.turnId === command.turnId)?.gitRef
      const ws = await this.#workspaceFor(model.session?.projectId ?? 'adhoc')
      if (ref && ws !== null) {
        const { GitService } = await import('@ari/engine/git')
        const result = await new GitService().revertToRef(ws, ref)
        if (!result.ok) {
          log.error('checkpoint revert failed', { error: result.error.message })
        }
      }
    }

    return { accepted: true }
  }

  async #append(sessionId: string, event: UnstampedEvent): Promise<JournalEvent> {
    const stamped = await this.#deps.store.append(sessionId, event)
    this.#deps.publish(sessionId, stamped)
    return stamped
  }

  /** Resolves the workspace folder for a session; null when unresolvable. */
  async #workspaceFor(projectId: string): Promise<string | null> {
    if (!this.#deps.resolveWorkspace) {
      // Legacy/test fallback: the id doubles as a literal path, unchecked.
      return projectId === 'adhoc' ? process.cwd() : projectId
    }
    const resolved = await this.#deps.resolveWorkspace(projectId)
    if (resolved !== null && !existsSync(resolved)) return null
    return resolved
  }

  /**
   * Runs one provider turn: spawns the adapter, maps normalized agent events
   * into journal parts (coalescing text), and settles the turn. `resumeOf`
   * carries the provider-native session/thread id observed on a previous
   * turn, so follow-up prompts continue the same provider thread.
   */
  async #runTurn(
    session: Session,
    prompt: string,
    turnId: string,
    resumeOf: string | null,
  ): Promise<void> {
    const driver = this.#deps.registry.get(session.driverKind)
    if (!driver) {
      await this.#settle(session.id, turnId, 'error', `no driver registered for ${session.driverKind}`)
      return
    }

    const workspacePath = await this.#workspaceFor(session.projectId)
    if (workspacePath === null) {
      await this.#settle(
        session.id,
        turnId,
        'error',
        `workspace folder not found for project ${session.projectId} — add the folder in Projects and try again`,
      )
      return
    }
    // Bracket the turn with a checkpoint when the workspace is a git repo
    // (PLAN §3). captureCheckpoint returns null outside repos; failures are
    // non-fatal — checkpoints are best-effort.
    const git = this.#deps.git ?? (await import('@ari/engine/git')).newDefaultCapturer()
    const captured = await git.captureCheckpoint(workspacePath, session.id, turnId)
    if (captured.ok && captured.value !== null) {
      await this.#append(session.id, {
        type: 'checkpoint.captured',
        turnId,
        gitRef: captured.value,
      })
      // M8.10: cap stored checkpoints per session. Pruning is event-sourced
      // (checkpoint.pruned folds the projection) and best-effort.
      const prune = git.pruneCheckpoints?.bind(git)
      if (prune) {
        const pruned = await prune(workspacePath, session.id, MAX_CHECKPOINTS_PER_SESSION)
        if (pruned.ok) {
          for (const ref of pruned.value) {
            const turnId = ref.slice(ref.lastIndexOf('/') + 1)
            if (turnId.length > 0) {
              await this.#append(session.id, { type: 'checkpoint.pruned', turnId, gitRef: ref })
            }
          }
        }
      }
    }

    let adapter
    try {
      adapter = await driver.create({
        sessionId: session.id,
        workspacePath,
        prompt,
        modelId: session.modelId,
        permissionMode: session.permissionMode,
        resumeOf,
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
      respondApproval: (approvalId, decision) => {
        adapter.respondApproval?.(approvalId, decision)
      },
      steer: (text) => {
        adapter.steer?.(text)
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
      let firstErrorMessage: string | null = null
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
            // Journal the question so the QuestionPanel can answer it via
            // `input.respond` and answers survive replay.
            await append({
              type: 'input.requested',
              inputId: event.inputId,
              prompt: event.prompt,
              choicesJson: event.choicesJson,
            })
            break
          case 'session-ref':
            // Persist the provider-native thread id so the next turn resumes
            // it instead of re-prompting cold.
            await append({ type: 'session.ref.observed', ref: event.ref })
            break
          case 'error':
            if (firstErrorMessage === null) firstErrorMessage = event.message
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
      // Provider-emitted errors (auth failures, CLI crashes with exit 0, HTTP
      // errors) must settle the turn as `error`, never as a completed chat —
      // otherwise the failure is invisible and the UI looks broken.
      if (!interrupted) {
        await this.#settle(session.id, turnId, firstErrorMessage === null ? 'completed' : 'error', firstErrorMessage)
      }
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
    const nextStatus = stopReason === 'error' ? 'error' : 'idle'
    // Fold status before publishing turn.settled so subscribers that load
    // the read model on settle already see idle/error, not a stale `running`.
    if (model.status !== nextStatus) {
      await this.#append(sessionId, {
        type: 'session.status.changed',
        from: model.status === 'unknown' ? 'idle' : model.status,
        to: nextStatus,
        reason: errorMessage,
      })
    }
    await this.#append(sessionId, {
      type: 'turn.settled',
      turnId,
      stopReason,
      errorMessage,
    })
    if (stopReason !== 'error') this.#onFirstSettle(sessionId)
  }

  /**
   * Title generation hook (M18.2): after the session's first settled turn
   * that did not end in error — and only while the title is still the
   * automatic slice of the first prompt — upgrades it through the configured
   * {@link TitleStrategy}. Fire-and-forget: never blocks or fails the turn.
   */
  #onFirstSettle(sessionId: string): void {
    if (this.#titleSettled.has(sessionId)) return
    this.#titleSettled.add(sessionId)
    void this.#generateTitle(sessionId).catch((e) => {
      log.debug('title generation skipped', { sessionId, error: String(e) })
    })
  }

  async #generateTitle(sessionId: string): Promise<void> {
    const model = await this.#deps.store.load(sessionId)
    const session = model.session
    const firstPrompt = model.messages.find((m) => m.role === 'user')
    if (!session || !firstPrompt) return
    const prompt = firstPrompt.parts.find((p) => p.type === 'text')?.text ?? ''
    if (!isAutoTitle(session.title, prompt)) return
    const strategy = this.#deps.titleStrategy ?? deterministicTitleStrategy
    const title = await strategy.generate({ prompt, currentTitle: session.title })
    if (title === null || title.length === 0 || title === session.title) return
    await this.#append(sessionId, { type: 'session.updated', title })
  }

  /** Live tail: replays the journal, then forwards appended events. */
  async replaySession(sessionId: string): Promise<JournalEvent[]> {
    const journal = await this.#deps.store.openJournal(sessionId)
    const entries = await journal.readAll()
    return entries.flatMap((e) => (e.kind === 'value' ? [e.value] : []))
  }
}

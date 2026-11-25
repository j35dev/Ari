import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import type { SlashCommand } from '@ari/contracts/slash-commands'
import { createLogger } from '@ari/shared/logger'
import type { QuestionItem } from '../acp/client-requests'
import { loadImageData, missingImagesNote } from '../attachments'
import { AsyncQueue } from '../claude/async-queue'
import type {
  AdapterApprovalDecision,
  AdapterSession,
  CommandListRequest,
  Driver,
  ProviderAdapter,
  ProviderCapabilities,
  SessionAttachment,
} from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { OcHttpError } from './http'
import { OpencodeTurnMapper } from './sdk-mapper'
import { OpencodeServerPool } from './server'
import type { OpencodeServer } from './server'
import type { OpencodeGeneration } from './version'
import type { OcPermissionReply, OcPromptInput, OcQuestionShape } from './wire'
import { splitModelId } from './wire'

const log = createLogger('providers:opencode-sdk')

/** How Ari talks to OpenCode: its server (default), ACP, or one-shot `run --format json`. */
export type OpencodeTransport = 'sdk' | 'acp' | 'cli'

export function resolveOpencodeTransport(value: string | undefined): OpencodeTransport {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'acp' || normalized === 'cli' ? normalized : 'sdk'
}

/** Shared by every OpenCode session in this app. */
export const opencodeServerPool = new OpencodeServerPool()

export function opencodeCapabilities(generation: OpencodeGeneration): ProviderCapabilities {
  return {
    ...ONE_SHOT_PROVIDER_CAPABILITIES,
    // OpenCode 2 delivers a steer before the next model call; the classic
    // server queues it and answers it before the turn goes idle.
    steering: generation === 'v2' ? 'live' : 'follow-up',
    liveResponses: 'approvals-and-input',
    processContinuity: 'between-turns',
    terminalStatus: 'explicit',
    nativeChildren: {
      ...ONE_SHOT_PROVIDER_CAPABILITIES.nativeChildren,
      visibility: 'full',
      inspect: true,
      approvals: true,
    },
  }
}

export interface OpencodeSdkDriverOptions {
  generation: OpencodeGeneration
  /** ACP (itself falling back to the one-shot CLI) when the server cannot start. */
  fallback?: Driver
  pool?: OpencodeServerPool
  /** Test seams for {@link STALE_IDLE_MS} and {@link ERROR_SETTLE_MS}. */
  timing?: { staleIdleMs?: number; errorSettleMs?: number }
}

const PROVIDER_DEFAULT_EFFORTS = new Set(['default', 'provider-default'])
/** How long after a prompt an idle with no sign of work is read as the last turn's echo. */
const STALE_IDLE_MS = 1500
/** How long an error with no work after it waits before it ends the turn. */
const ERROR_SETTLE_MS = 5000

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

async function promptInput(
  session: Pick<AdapterSession, 'modelId' | 'effort'>,
  text: string,
  attachments: readonly SessionAttachment[],
): Promise<OcPromptInput> {
  const { loaded, missing } = await loadImageData([...attachments])
  // Loaded images keep the staged order, minus the ones that could not be read.
  const present = attachments.filter((attachment) => !missing.includes(attachment))
  const model = splitModelId(session.modelId)
  const effort = session.effort ?? null
  return {
    text: text + missingImagesNote(missing),
    files: loaded.map((image, index) => ({
      url: `data:${image.mimeType};base64,${image.dataBase64}`,
      mime: image.mimeType,
      name: present[index]?.name ?? `image-${index + 1}`,
    })),
    model,
    // A variant belongs to a model; without one there is nothing to apply it to.
    variant: model && effort && !PROVIDER_DEFAULT_EFFORTS.has(effort) ? effort : null,
  }
}

/** `{ answers: { id: value } }`, a bare map, or plain text for a single question. */
export function parseAnswers(
  value: string,
  questions: QuestionItem[],
): Record<string, string | string[]> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const inner = obj['answers']
      const source =
        inner !== null && typeof inner === 'object' && !Array.isArray(inner)
          ? (inner as Record<string, unknown>)
          : obj
      const out: Record<string, string | string[]> = {}
      for (const [key, raw] of Object.entries(source)) {
        if (typeof raw === 'string') out[key] = raw
        else if (Array.isArray(raw))
          out[key] = raw.filter((x): x is string => typeof x === 'string')
      }
      return out
    }
  } catch {
    // Plain text.
  }
  const only = questions.length === 1 ? questions[0] : undefined
  return only && value.trim().length > 0 ? { [only.id]: value } : {}
}

/** Ari's approval vocabulary onto OpenCode's three replies. */
export function permissionReply(decision: AdapterApprovalDecision): OcPermissionReply | null {
  if (typeof decision === 'object')
    return decision.optionId === 'once' ||
      decision.optionId === 'always' ||
      decision.optionId === 'reject'
      ? decision.optionId
      : null
  return decision === 'allow' ? 'once' : decision === 'always-allow' ? 'always' : 'reject'
}

/** The server cannot hold the session to Ari's permission mode. */
export class RulesUnsupportedError extends Error {
  constructor() {
    super(
      'This OpenCode build cannot apply per-session permission rules, so it would run edits and shell commands without asking. Use Full access, or update OpenCode.',
    )
    this.name = 'RulesUnsupportedError'
  }
}

/**
 * OpenCode through its own HTTP server, the way Claude runs through the Agent
 * SDK: one shared `opencode serve` per binary, a live event stream, and the
 * server's own session, permission, question and steering endpoints. Supports
 * classic OpenCode (1.x) and OpenCode 2, chosen by `generation`.
 */
export class OpencodeSdkDriver implements Driver {
  readonly kind = 'opencode' as const
  readonly #pool: OpencodeServerPool
  readonly #capabilities: ProviderCapabilities
  /** Permission mode last written to each native session, so unchanged turns skip the call. */
  readonly #modes = new Map<string, PermissionMode>()
  /** Servers that accept sessions but not their permission rules (OpenCode 2 previews). */
  readonly #withoutRules = new WeakSet<OpencodeServer>()

  constructor(
    private readonly binary: string,
    private readonly options: OpencodeSdkDriverOptions,
  ) {
    this.#pool = options.pool ?? opencodeServerPool
    this.#capabilities = opencodeCapabilities(options.generation)
  }

  get generation(): OpencodeGeneration {
    return this.options.generation
  }

  capabilities(): Readonly<ProviderCapabilities> {
    return this.#capabilities
  }

  hasLiveSession(sessionId: string): boolean {
    return this.options.fallback?.hasLiveSession?.(sessionId) ?? false
  }

  #spec(env: Record<string, string | undefined> | undefined) {
    return {
      binary: this.binary,
      generation: this.options.generation,
      env: env ?? { ...process.env },
    }
  }

  async listCommands(request: CommandListRequest): Promise<SlashCommand[]> {
    let server: OpencodeServer | null = null
    try {
      server = await this.#pool.acquire(this.#spec(request.runtimeEnv), { anyEnvironment: true })
      const commands = await server.wire.commands(request.workspacePath)
      return commands.map((command) => ({
        name: command.name,
        description: command.description.slice(0, 2_000),
        argumentHint: null,
        source: command.source === 'skill' ? 'skill' : command.source === 'mcp' ? 'mcp' : 'project',
        run: 'rpc',
      }))
    } catch (error) {
      log.debug('OpenCode command list failed', { error: String(error) })
      return this.options.fallback?.listCommands?.(request) ?? []
    } finally {
      if (server) this.#pool.release(server)
    }
  }

  async create(session: AdapterSession): Promise<ProviderAdapter> {
    const fallback = this.options.fallback
    // A session still parked on ACP keeps that transport until it is released.
    if (fallback?.hasLiveSession?.(session.sessionId)) return fallback.create(session)
    let server: OpencodeServer | null = null
    let nativeId: string
    let input: OcPromptInput
    const notices: string[] = []
    try {
      server = await this.#pool.acquire(this.#spec(session.runtimeEnv))
      const wire = server.wire
      const directory = session.workspacePath
      const mode = session.permissionMode
      // Without session rules the agent's defaults decide, and OpenCode's
      // build agent runs edits and shell unasked: only Full access is honest there.
      if (mode !== 'full' && this.#withoutRules.has(server)) throw new RulesUnsupportedError()
      const resumed =
        session.resumeOf !== null && (await wire.sessionExists(session.resumeOf, directory))
      if (resumed) {
        nativeId = session.resumeOf!
        if (this.#modes.get(nativeId) !== mode)
          await wire.setPermissions(nativeId, directory, mode).catch((error: unknown) => {
            log.warn('OpenCode session permissions not updated', { error: String(error) })
            if (error instanceof OcHttpError && error.status === 404)
              this.#withoutRules.add(server!)
            // Rules that stay stricter than asked are safe to run under.
            if (mode !== 'full') throw new RulesUnsupportedError()
            notices.push(
              'OpenCode could not change this session’s permission rules; it keeps the ones it started with.',
            )
          })
      } else {
        const created = await wire.createSession(directory, mode)
        nativeId = created.id
        if (!created.rulesApplied) {
          this.#withoutRules.add(server)
          if (mode !== 'full') {
            await wire.deleteSession(nativeId, directory).catch(() => {})
            throw new RulesUnsupportedError()
          }
        }
      }
      this.#modes.set(nativeId, session.permissionMode)
      if (wire.setEnvironment && session.runtimeEnv)
        await wire.setEnvironment(nativeId, directory, stringEnv(session.runtimeEnv))
      input = await promptInput(session, session.prompt, session.attachments ?? [])
    } catch (error) {
      if (server) this.#pool.release(server)
      // Nothing was prompted yet, so a fallback cannot run the turn twice.
      log.warn(
        error instanceof RulesUnsupportedError
          ? 'OpenCode server cannot apply this permission mode; using the fallback transport'
          : 'OpenCode server unavailable',
        { error: String(error) },
      )
      if (fallback) return fallback.create(session)
      throw error
    }
    return this.#turn(session, server, nativeId, input, notices)
  }

  #turn(
    session: AdapterSession,
    server: OpencodeServer,
    nativeId: string,
    input: OcPromptInput,
    notices: string[],
  ): ProviderAdapter {
    const wire = server.wire
    const directory = session.workspacePath
    const queue = new AsyncQueue<AgentEvent>()
    const mapper = new OpencodeTurnMapper(nativeId)
    const approvals = new Map<string, string>()
    const questions = new Map<
      string,
      { sessionID: string; shape: OcQuestionShape; questions: QuestionItem[] }
    >()
    let finished = false
    let interrupted = false
    let released = false
    let active = false
    let errorTimer: NodeJS.Timeout | null = null
    const sentAt = Date.now()
    const staleIdleMs = this.options.timing?.staleIdleMs ?? STALE_IDLE_MS
    const errorSettleMs = this.options.timing?.errorSettleMs ?? ERROR_SETTLE_MS
    const cleanup: (() => void)[] = []
    const finish = (stopReason: 'completed' | 'interrupted' | 'error') => {
      if (finished) return
      finished = true
      if (errorTimer) clearTimeout(errorTimer)
      approvals.clear()
      questions.clear()
      queue.push({ type: 'done', stopReason })
      queue.end()
      for (const stop of cleanup.splice(0)) stop()
    }
    const fail = (message: string) => {
      if (finished) return
      queue.push({ type: 'error', message, rawJson: null })
      finish('error')
    }
    cleanup.push(
      server.on((event) => {
        if (finished) return
        const root = event.type !== 'session' && event.sessionID === nativeId
        if (root && event.type === 'idle') {
          // The idle that follows an interrupt of the previous turn can land
          // just after this prompt. Before the session showed any sign of
          // working on it, a prompt-fresh idle is that echo, not this turn's end.
          if (!active && Date.now() - sentAt < staleIdleMs) return
        } else if (root) {
          active = true
          if (errorTimer && event.type !== 'error') {
            clearTimeout(errorTimer)
            errorTimer = null
          }
          // The classic server reports a prompt it could not start only as an
          // error, with no idle after it.
          if (event.type === 'error' && !errorTimer)
            errorTimer = setTimeout(() => finish('error'), errorSettleMs)
        }
        if (event.type === 'permission' && mapper.owns(event.sessionID))
          approvals.set(event.id, event.sessionID)
        if (event.type === 'question' && mapper.owns(event.sessionID))
          questions.set(event.id, {
            sessionID: event.sessionID,
            shape: event.shape,
            questions: event.questions,
          })
        const mapped = mapper.map(event)
        for (const out of mapped.events) queue.push(out)
        if (mapped.end) finish(interrupted ? 'interrupted' : mapped.end)
      }),
      server.onClosed((reason) => fail(reason)),
    )
    queue.push({ type: 'session-ref', ref: nativeId })
    for (const message of notices) queue.push({ type: 'notice', message })
    const send = session.command
      ? wire.command(nativeId, directory, session.command.name, session.command.args, input)
      : wire.prompt(nativeId, directory, input)
    send.catch((error: unknown) => {
      // An HTTP error is a refusal. A timeout or dropped connection is not:
      // the prompt may well be running, and if the session shows work the
      // turn's own events end it.
      if (!(error instanceof OcHttpError) && active) {
        log.warn('OpenCode prompt request did not complete; following the session events', {
          error: String(error),
        })
        return
      }
      fail(`OpenCode did not accept the prompt: ${String(error)}`)
    })

    const release = () => {
      if (released) return
      released = true
      this.#pool.release(server)
    }
    return {
      capabilities: () => this.#capabilities,
      start: () => queue,
      keepsBackgroundWork: () => false,
      continuesBackgroundWork: () => false,
      respondApproval: (approvalId, decision) => {
        const sessionID = approvals.get(approvalId)
        const reply = permissionReply(decision)
        if (sessionID === undefined || reply === null) return
        approvals.delete(approvalId)
        void wire
          .replyPermission(sessionID, approvalId, directory, reply)
          .catch((error: unknown) =>
            log.warn('OpenCode permission reply failed', { error: String(error) }),
          )
      },
      respondInput: (inputId, value) => {
        const entry = questions.get(inputId)
        if (entry === undefined) return
        questions.delete(inputId)
        const answers = parseAnswers(value, entry.questions)
        const reply =
          Object.keys(answers).length === 0
            ? wire.rejectQuestion(entry.sessionID, inputId, directory)
            : wire.replyQuestion(
                entry.sessionID,
                inputId,
                directory,
                entry.shape,
                entry.questions,
                answers,
              )
        void reply.catch((error: unknown) =>
          log.warn('OpenCode question reply failed', { error: String(error) }),
        )
      },
      ...(wire.steer
        ? {
            steer: async (text: string, attachments: readonly SessionAttachment[] = []) => {
              if (finished || interrupted || !wire.steer) return false
              const message = await promptInput({ modelId: null, effort: null }, text, attachments)
              if (finished || interrupted) return false
              try {
                await wire.steer(nativeId, directory, message)
                return true
              } catch (error) {
                // A refusal is certain; anything else may have been delivered.
                if (error instanceof OcHttpError && error.status >= 400 && error.status < 500)
                  return false
                throw error
              }
            },
          }
        : {}),
      interrupt: () => {
        if (finished || interrupted) return
        interrupted = true
        void wire
          .interrupt(nativeId, directory)
          .catch((error: unknown) =>
            log.warn('OpenCode interrupt failed', { error: String(error) }),
          )
        finish('interrupted')
      },
      dispose: () => {
        // A turn dropped mid-flight must not keep the model working unseen.
        if (!finished) {
          interrupted = true
          void wire.interrupt(nativeId, directory).catch(() => {})
          finish('interrupted')
        }
        release()
        return Promise.resolve()
      },
    }
  }
}

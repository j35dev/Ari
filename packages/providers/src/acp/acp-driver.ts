import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { createLogger } from '@ari/shared/logger'
import { formatUnknownError } from '@ari/shared/result'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { AcpAuthRequiredError, AcpConnection, AcpConnectionError } from './connection'
import type { AcpChildProcess, AcpLaunch } from './connection'
import {
  encodeQuestionnaire,
  isAskUserQuestionMethod,
  isExitPlanModeMethod,
  isQuestionPermission,
  parseAskUserQuestions,
  parseElicitationForm,
  parsePlanExit,
  questionsFromPermission,
  replyAskUser,
  replyAskUserCancelled,
  replyElicitation,
  replyElicitationCancel,
  replyPermissionCancelled,
  replyPermissionChoice,
  replyPlanExit,
} from './client-requests'
import { findThoughtOption, looksLikeThoughtAxis } from './thought'
import { AcpUpdateFolder, stopReasonEvents } from './protocol'
import type {
  AcpConfigOption,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpRequestPermission,
  AcpTerminalLogin,
} from './protocol'

const log = createLogger('providers:acp')

/** Approval vocabulary shared with `approval.respond` commands. */
export type AdapterApprovalDecision = 'allow' | 'deny' | 'always-allow'

/**
 * Reports that the agent refused for want of a login, with whatever logins it
 * advertised. Called at most once per turn, on the handshake or mid-turn, so a
 * host can offer sign-in without parsing error text.
 */
export type AcpAuthRequiredHandler = (wall: { label: string; logins: AcpTerminalLogin[] }) => void

export interface AcpAdapter extends ProviderAdapter {
  /** Answers a pending `session/request_permission` originated approval. */
  respondApproval(approvalId: string, decision: AdapterApprovalDecision): void
  /** Answers a pending `input-requested` question (elicitation, ask-user, plan). */
  respondInput(inputId: string, value: string): void
}

/**
 * Connects the ACP agent, opens the session bound to the workspace, applies
 * model + permission-mode config options when the agent advertises them,
 * and returns an adapter whose event stream folds session updates.
 *
 * The prompt is sent on the first `start()` pull; permission requests are
 * bridged to Ari's approval flow and parked until respondApproval arrives
 * (or the turn ends/cancels).
 */
export async function createAcpAdapter(
  launch: AcpLaunch,
  session: AdapterSession,
  spawn?: (childLaunch: AcpLaunch, cwd: string) => AcpChildProcess,
  onAuthRequired?: AcpAuthRequiredHandler,
): Promise<AcpAdapter> {
  const pendingPermissions = new Map<
    string,
    { options: AcpRequestPermission['options']; resolve: (outcome: unknown) => void }
  >()
  const pendingInputs = new Map<
    string,
    {
      resolve: (outcome: unknown) => void
      toResult: (value: string) => unknown
      cancelResult: unknown
    }
  >()
  let permissionSeq = 0
  let inputSeq = 0

  const folder = new AcpUpdateFolder()
  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  const push = (events: AgentEvent[]): void => {
    if (events.length === 0) return
    queue.push(...events)
    notify?.()
    notify = null
  }

  const parkInput = (
    prompt: string,
    choicesJson: string,
    toResult: (value: string) => unknown,
    cancelResult: unknown,
  ): Promise<unknown> => {
    return new Promise((resolve) => {
      const inputId = `acp-in-${++inputSeq}`
      pendingInputs.set(inputId, { resolve, toResult, cancelResult })
      push([{ type: 'input-requested', inputId, prompt, choicesJson }])
    })
  }

  const onRequestPermission = (request: AcpRequestPermission): Promise<unknown> => {
    if (isQuestionPermission(request.options)) {
      const title = request.toolCall?.title ?? request.toolCall?.kind ?? 'Choose an option'
      const questions = questionsFromPermission(title, request.options)
      return parkInput(
        title,
        encodeQuestionnaire({ kind: 'questionnaire', questions }),
        (value) => replyPermissionChoice(request.options, value),
        replyPermissionCancelled(),
      )
    }
    return new Promise((resolve) => {
      const approvalId = `acp-perm-${++permissionSeq}`
      pendingPermissions.set(approvalId, { options: request.options, resolve })
      push([
        {
          type: 'approval-requested',
          approvalId,
          toolName: request.toolCall?.title ?? request.toolCall?.kind ?? 'tool',
          summaryJson: JSON.stringify({
            kind: request.toolCall?.kind ?? null,
            rawInput: request.toolCall?.rawInput ?? null,
            locations: request.toolCall?.locations ?? [],
            options: request.options ?? [],
          }),
        },
      ])
    })
  }

  const onClientRequest = (method: string, params: unknown): Promise<unknown> => {
    if (isAskUserQuestionMethod(method)) {
      const questions = parseAskUserQuestions(params)
      const prompt = questions[0]?.question ?? 'Question'
      return parkInput(
        questions.length > 1 ? `${questions.length} questions` : prompt,
        encodeQuestionnaire({ kind: 'questionnaire', questions }),
        (value) => replyAskUser(questions, value),
        replyAskUserCancelled(),
      )
    }
    if (isExitPlanModeMethod(method)) {
      const plan = parsePlanExit(params)
      return parkInput(
        'Approve this plan?',
        encodeQuestionnaire({
          kind: 'plan-approval',
          questions: [],
          ...(plan.planContent.length > 0 ? { planContent: plan.planContent } : {}),
        }),
        replyPlanExit,
        { outcome: 'cancelled' },
      )
    }
    if (method === 'elicitation/create') {
      const form = parseElicitationForm(params)
      if (form.url) return Promise.resolve(replyElicitationCancel())
      const prompt = form.message.length > 0 ? form.message : (form.questions[0]?.question ?? 'Question')
      return parkInput(
        form.questions.length > 1 ? form.message || `${form.questions.length} questions` : prompt,
        encodeQuestionnaire({ kind: 'questionnaire', questions: form.questions }),
        (value) => replyElicitation(form.questions, value),
        replyElicitationCancel(),
      )
    }
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  }

  /**
   * Keeps an auth wall recognizable through the setup-failure wrapping, and
   * reports it once so the host can offer the agent's own logins instead of
   * leaving the user to guess at an expired session.
   */
  const setupFailure = (error: unknown): Error => {
    if (error instanceof AcpAuthRequiredError) {
      onAuthRequired?.({ label: launch.label, logins: error.logins })
      return new AcpAuthRequiredError(formatAcpSetupError(error), error.logins)
    }
    return new Error(formatAcpSetupError(error), { cause: error })
  }

  const effectiveLaunch = launchWithEffort(launch, session.effort ?? null)
  let connection: AcpConnection
  try {
    connection = await AcpConnection.connect({
      launch: effectiveLaunch,
      cwd: session.workspacePath,
      ...(spawn !== undefined ? { spawn } : {}),
    })
  } catch (error) {
    throw setupFailure(error)
  }

  connection.onRequestPermission = onRequestPermission
  connection.onClientRequest = onClientRequest
  // Session updates stay unhooked until after session/load returns. The spec
  // says the agent replays the whole prior conversation as session/update
  // notifications before that call resolves; folding them here would reprint
  // turn 1's answer as the start of turn 2. Ari already has that transcript
  // in the journal.

  /**
   * Resumes the agent's persisted session when possible so multi-turn context
   * survives Ari's spawn-per-turn model; otherwise opens a fresh one. Prefer
   * `session/resume` (no history replay) when advertised, then `session/load`.
   * A failure degrades to a fresh session rather than failing the turn. The
   * `resumed` flag tells {@link resolveSelectors} whether an absent mode/model
   * selector means "the agent has none" or "session/load answered with the
   * empty body the spec allows".
   */
  const openSession = async (): Promise<{ created: AcpNewSessionResult; resumed: boolean }> => {
    const resumeId = session.resumeOf
    if (typeof resumeId === 'string' && resumeId.length > 0) {
      if (sessionResumeSupported(connection.initialize)) {
        try {
          return { created: await connection.resumeSession(resumeId, session.workspacePath), resumed: true }
        } catch (error) {
          log.warn('acp: session/resume failed; trying session/load', {
            resumeId,
            error: String(error instanceof Error ? error.message : error),
          })
        }
      }
      if (connection.initialize.agentCapabilities?.loadSession === true) {
        try {
          return { created: await connection.loadSession(resumeId, session.workspacePath), resumed: true }
        } catch (error) {
          log.warn('acp: session/load failed; starting a fresh session', {
            resumeId,
            error: String(error instanceof Error ? error.message : error),
          })
        }
      }
    }
    return { created: await connection.newSession(session.workspacePath), resumed: false }
  }

  let created: AcpNewSessionResult
  let resumed: boolean
  try {
    const opened = await openSession()
    created = opened.created
    resumed = opened.resumed
  } catch (error) {
    connection.kill()
    throw setupFailure(error)
  }
  // pi-acp can emit its startup prelude as a regular agent message when the
  // client does not consume the copy carried in session/new metadata. The
  // response is delivered before pi-acp's deferred notification, so the
  // folder has the exact prelude before that notification can be folded.
  folder.setStartupInfo(created._meta?.piAcp?.startupInfo)
  const sessionId = created.sessionId as string
  connection.onSessionUpdate = (notification) => push(folder.fold(notification))
  // Publish the agent's session id so Ari can resume it via session/load on
  // the next turn instead of losing all context.
  push([{ type: 'session-ref', ref: sessionId }])

  const selectors = resolveSelectors(launch.label, created, resumed)
  await applyModel(connection, sessionId, selectors.configOptions, session.modelId)
  await applyPermissionMode(
    connection,
    sessionId,
    selectors.configOptions,
    selectors.availableModes,
    session.permissionMode,
  )
  await applyThoughtLevel(
    connection,
    sessionId,
    selectors.configOptions,
    selectors.availableModes,
    session.effort ?? null,
    launch.label,
  )

  /**
   * Releases anything the turn was still waiting on. Parked permission
   * requests must be answered before the process goes away, or the agent sits
   * on a request whose client has already left.
   */
  const releasePending = (): void => {
    for (const pending of pendingPermissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } })
    pendingPermissions.clear()
    // Answer parked interactive requests as a JSON-RPC *success* cancel.
    // A method-not-found or a dropped request is what Grok reads as
    // "the client disconnected"; plan mode then stays stuck.
    for (const pending of pendingInputs.values()) pending.resolve(pending.cancelResult)
    pendingInputs.clear()
  }

  // ACP has no mid-turn injection method, so steering rides out as the next
  // `session/prompt` the moment the current one reports its stop reason — one
  // continuous stream from the user's point of view, no queue-then-restart.
  const steeredTexts: string[] = []
  const launchPrompt = (text: string): void => {
    void connection
      .prompt(sessionId, text)
      .then((stopReason) => {
        const next = steeredTexts.shift()
        if (next === undefined || connection.closed) {
          push(stopReasonEvents(stopReason))
          return
        }
        log.debug('acp steering applied at turn boundary', { sessionId })
        launchPrompt(next)
      })
      .catch((error: unknown) => {
        log.debug('acp prompt failed', { error: String(error) })
        // A token can expire mid-turn, so the sign-in path has to be reachable
        // from here too — not just from the handshake.
        if (error instanceof AcpAuthRequiredError) {
          onAuthRequired?.({ label: launch.label, logins: error.logins })
        }
        // Texts consumed as steering but never delivered must not vanish.
        const lost = steeredTexts.splice(0)
        push([
          ...(lost.length > 0
            ? ([{ type: 'error', message: `steering lost after transport failure: ${lost.join(' | ')}`, rawJson: null }] satisfies AgentEvent[])
            : []),
          { type: 'error', message: formatUnknownError(error), rawJson: null },
          { type: 'done' },
        ])
      })
  }

  const iterator = (async function* generate(): AsyncGenerator<AgentEvent, void, undefined> {
    // The turn's prompt rides out on first pull; its completion closes the stream
    // — after any steered follow-ups have been chained onto it.
    launchPrompt(session.prompt)

    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()
        if (event === undefined) continue
        yield event
        if (event.type === 'done') return
      }
      if (connection.closed && queue.length === 0) {
        yield { type: 'error', message: `${launch.label} ended before completing the turn`, rawJson: null }
        yield { type: 'done' }
        return
      }
      await new Promise<void>((resolve) => {
        notify = resolve
        if (queue.length > 0 || connection.closed) resolve()
      })
    }
  })()

  return {
    start: () => ({ [Symbol.asyncIterator]: () => iterator }),
    interrupt: () => connection.cancel(sessionId),
    steer: (text) => {
      steeredTexts.push(text)
    },
    respondApproval: (approvalId, decision) => {
      const pending = pendingPermissions.get(approvalId)
      if (pending === undefined) return
      pendingPermissions.delete(approvalId)
      const kinds =
        decision === 'deny'
          ? ['reject_once', 'reject_always']
          : decision === 'always-allow'
            ? ['allow_always', 'allow_once']
            : ['allow_once', 'allow_always']
      const optionId = optionFor(pending.options, kinds)
      pending.resolve(
        optionId !== undefined
          ? { outcome: { outcome: 'selected', optionId } }
          : { outcome: { outcome: 'cancelled' } },
      )
    },
    respondInput: (inputId, value) => {
      const pending = pendingInputs.get(inputId)
      if (pending === undefined) return
      pendingInputs.delete(inputId)
      pending.resolve(pending.toResult(value))
    },
    dispose: async () => {
      releasePending()
      // Cancel first so the agent can stop its own tools and children in
      // order; the ladder in shutdown() is what guarantees they are gone.
      if (!connection.closed) connection.cancel(sessionId)
      await connection.shutdown()
    },
  }
}

/** True when the agent advertised `session/resume` (no history replay). */
export function sessionResumeSupported(initialize: AcpInitializeResult): boolean {
  return initialize.agentCapabilities?.sessionCapabilities?.resume === true
}

function formatAcpSetupError(error: unknown): string {
  if (error instanceof AcpConnectionError) return error.message
  return `ACP transport unavailable: ${formatUnknownError(error)}`
}

/**
 * Permission options carry semantic kinds; map a decision onto whichever
 * flavor the agent offered, in priority order. Falls back to undefined so
 * the caller can cancel instead of fabricating an option id.
 */
function optionFor(
  options: AcpRequestPermission['options'],
  kinds: string[],
): string | undefined {
  const list = options ?? []
  for (const kind of kinds) {
    const match = list.find((o) => o.kind === kind && typeof o.optionId === 'string')
    if (match !== undefined) return match.optionId
  }
  return undefined
}

/** The mode/model selectors an agent advertises for a session. */
interface AcpSelectors {
  configOptions: AcpConfigOption[]
  availableModes: { id?: string; name?: string }[]
}

/**
 * Selector vocabulary learned per agent, keyed by launch label.
 *
 * `session/load` is specified to answer with an empty body, so a resumed
 * session usually advertises no mode selector at all — and Ari spawns a fresh
 * agent process per turn. Without this cache the second turn of a session can
 * never move the agent's mode, which is how a session started in Ask mode left
 * opencode parked in `plan` and answering every later prompt with "exit plan
 * mode first" — an instruction Ari's UI has no way to follow. The vocabulary is
 * a property of the agent, not of one session, so any earlier `session/new` in
 * this run supplies it. Only consulted for resumed sessions: a fresh
 * `session/new` that advertises nothing genuinely supports nothing, and pushing
 * an unsupported request at it would just burn the call's timeout.
 */
const LEARNED_SELECTORS = new Map<string, AcpSelectors>()

/** Prefers what this open advertised; a resume falls back to the learned vocabulary. */
function resolveSelectors(
  label: string,
  created: AcpNewSessionResult,
  resumed: boolean,
): AcpSelectors {
  const configOptions = created.configOptions ?? []
  const availableModes = created.modes?.availableModes ?? []
  if (configOptions.length > 0 || availableModes.length > 0) {
    const learned = LEARNED_SELECTORS.get(label)
    const merged: AcpSelectors = {
      configOptions: configOptions.length > 0 ? configOptions : (learned?.configOptions ?? []),
      availableModes: availableModes.length > 0 ? availableModes : (learned?.availableModes ?? []),
    }
    LEARNED_SELECTORS.set(label, merged)
    return merged
  }
  if (!resumed) return { configOptions: [], availableModes: [] }
  return LEARNED_SELECTORS.get(label) ?? { configOptions: [], availableModes: [] }
}

/** Test seam: drops the learned vocabulary so cases cannot leak into each other. */
export function __resetLearnedAcpSelectors(): void {
  LEARNED_SELECTORS.clear()
}

async function applyModel(
  connection: AcpConnection,
  sessionId: string,
  configOptions: AcpConfigOption[],
  modelId: string | null,
): Promise<void> {
  if (modelId === null || modelId === 'default') return
  const option = findOption(configOptions, 'model')
  if (option === null || option.options === undefined) return
  const value = option.options.find((v) => v.value === modelId)?.value
  if (value === undefined) {
    log.debug('acp: requested model not advertised by agent', { modelId })
    return
  }
  try {
    await connection.setConfigOption(sessionId, option.id as string, value)
  } catch (error) {
    log.debug('acp: set_config_option(model) failed', { error: String(error) })
  }
}
/**
 * Maps Ari permission modes onto whatever mode selector the agent exposes
 * (config options preferred, legacy `session/set_mode` fallback). Sends nothing
 * when {@link pickAgentMode} finds no safe target, so an unrecognized agent
 * keeps its own default rather than being guessed into the wrong mode.
 */
async function applyPermissionMode(
  connection: AcpConnection,
  sessionId: string,
  configOptions: AcpConfigOption[],
  availableModes: { id?: string; name?: string }[],
  mode: PermissionMode,
): Promise<void> {
  const option = findOption(configOptions, 'mode')
  if (option !== null && option.options !== undefined && option.id !== undefined) {
    const chosen = pickAgentMode(option.options.map((v) => v.value), mode)
    if (chosen === null) return
    try {
      await connection.setConfigOption(sessionId, option.id, chosen)
    } catch (error) {
      log.debug('acp: set_config_option(mode) failed', { error: String(error) })
    }
    return
  }
  const chosen = pickAgentMode(availableModes.map((m) => m.id), mode)
  if (chosen === null) return
  try {
    await connection.setMode(sessionId, chosen)
  } catch (error) {
    log.debug('acp: set_mode failed', { error: String(error) })
  }
}

/** Modes that make an agent refuse to write; a build mode must never land here. */
const PLANNING_PATTERNS = [/\bplan(ning)?\b/i, /read.?only/i, /\bchat\b/i, /\bask\b/i]

const ASK_PATTERNS = [
  /\bask\b/i,
  /\bdefault\b/i,
  /\bnormal\b/i,
  /\bstandard\b/i,
  /\bplan(ning)?\b/i,
]
// `build` is opencode's write-capable mode; `code` is the same idea elsewhere.
const EDIT_PATTERNS = [
  /accept.?edits?/i,
  /\bedit(s|ing)?\b/i,
  /\bworkspace\b/i,
  /\bbuild\b/i,
  /^code$/i,
]
const FULL_PATTERNS = [/bypass/i, /yolo/i, /\bfull\b/i, /\bauto\b/i, /danger/i]

/** Preference chain per Ari mode: first vocabulary that matches wins. */
const MODE_PREFERENCE: Record<PermissionMode, RegExp[][]> = {
  ask: [ASK_PATTERNS],
  'allow-edits': [EDIT_PATTERNS, FULL_PATTERNS],
  full: [FULL_PATTERNS, EDIT_PATTERNS],
}

/**
 * Whether an advertised vocabulary is about permissions at all.
 *
 * `session/set_mode` carries no category, so the mode list is whatever axis the
 * agent happens to model as "modes" — and for pi's ACP adapter that axis is the
 * *thinking* level (`off`, `minimal`, … `xhigh`). Ari must be able to tell the
 * two apart before it writes anything: one recognizable permission word in the
 * list is the evidence that the axis is Ari's to drive.
 */
function looksLikePermissionAxis(values: string[]): boolean {
  const vocabulary = [...PLANNING_PATTERNS, ...ASK_PATTERNS, ...EDIT_PATTERNS, ...FULL_PATTERNS]
  return values.some((value) => matchesAny(value, vocabulary))
}

/**
 * Resolves an Ari permission mode against the mode vocabulary an agent
 * advertises, in candidate order. Returns null when nothing safe matches, which
 * the caller reads as "leave the agent alone".
 *
 * The two build modes take a last-resort escape hatch that `ask` deliberately
 * does not: any advertised mode that is not a planning/read-only mode. Agents
 * whose write mode Ari cannot name (opencode's `build` before it was listed
 * here) would otherwise be stranded in the planning mode a previous Ask-mode
 * turn selected, with no way out from inside Ari. Guessing in the other
 * direction would silently escalate permissions, so `ask` never falls back.
 *
 * The hatch is gated on {@link looksLikePermissionAxis}: applied to a list that
 * is not about permissions it picks the first entry, which is how an
 * allow-edits turn against pi used to send `set_mode('off')` and silently
 * disable the agent's reasoning.
 */
export function pickAgentMode(
  candidates: (string | undefined)[],
  mode: PermissionMode,
): string | null {
  const values = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0)
  for (const patterns of MODE_PREFERENCE[mode]) {
    const match = values.find((v) => matchesAny(v, patterns))
    if (match !== undefined) return match
  }
  if (mode === 'ask') return null
  if (!looksLikePermissionAxis(values)) return null
  return values.find((v) => !matchesAny(v, PLANNING_PATTERNS)) ?? null
}

function matchesAny(value: string | boolean | undefined, patterns: RegExp[]): boolean {
  return typeof value === 'string' && patterns.some((p) => p.test(value))
}

function findOption(
  configOptions: AcpConfigOption[],
  category: 'model' | 'mode',
): AcpConfigOption | null {
  return configOptions.find((o) => o.category === category && o.type === 'select') ?? null
}

/**
 * Applies the user's thought/reasoning pick onto the agent's own selector.
 * Config options (`thought_level`, or id aliases like `effort`) are preferred;
 * a thinking-shaped `session/set_mode` axis (pi) is the fallback. Unknown
 * values are skipped so we never push a level the harness did not advertise.
 */
async function applyThoughtLevel(
  connection: AcpConnection,
  sessionId: string,
  configOptions: AcpConfigOption[],
  availableModes: { id?: string; name?: string }[],
  effort: string | null,
  launchLabel: string,
): Promise<void> {
  if (effort === null || effort.length === 0) return
  const option = findThoughtOption(configOptions)
  if (option !== null && option.id !== undefined) {
    const advertised = option.options ?? []
    if (advertised.length > 0 && !advertised.some((v) => v.value === effort)) {
      log.debug('acp: requested thought level not advertised by agent', { effort })
      return
    }
    try {
      await connection.setConfigOption(sessionId, option.id, effort)
    } catch (error) {
      log.debug('acp: set_config_option(thought) failed', { error: String(error) })
    }
    return
  }
  const ids = availableModes.map((m) => m.id).filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (looksLikeThoughtAxis(ids) && ids.includes(effort)) {
    try {
      await connection.setMode(sessionId, effort)
    } catch (error) {
      log.debug('acp: set_mode(thought) failed', { error: String(error) })
    }
    return
  }
  // Grok documents configId `reasoning_effort` even when session/new omitted the
  // option (or listed it with an empty options array for an unsupported model).
  if (!/^grok\b/i.test(launchLabel)) return
  try {
    await connection.setConfigOption(sessionId, 'reasoning_effort', effort)
  } catch (error) {
    log.debug('acp: set_config_option(reasoning_effort) failed', { error: String(error) })
  }
}

/** Grok's `--effort` is a top-level `grok` flag, before `agent stdio`. */
export function launchWithEffort(launch: AcpLaunch, effort: string | null): AcpLaunch {
  if (effort === null || effort.length === 0) return launch
  if (!/^grok\b/i.test(launch.label)) return launch
  if (launch.args.includes('--effort')) return launch
  return { ...launch, args: ['--effort', effort, ...launch.args] }
}

/**
 * Whether an ACP setup failure is worth retrying on the legacy CLI driver.
 * Auth walls are not: both transports read the same credential store, so the
 * retry cannot succeed and only replaces an actionable "sign in again" with
 * whichever timeout the unauthenticated CLI happens to hit first.
 */
export function shouldFallBack(error: unknown): boolean {
  return !(error instanceof AcpAuthRequiredError)
}

/**
 * Driver that prefers the ACP transport and transparently falls back to the
 * legacy one-shot CLI driver whenever ACP is disabled, unresolvable, or its
 * connect/session handshake fails. Registration-time wiring lives in
 * {@link resolveAcpLaunch}; the fallback keeps every provider usable even
 * while adapters drift — except for the auth walls {@link shouldFallBack}
 * excludes, which propagate as {@link AcpAuthRequiredError}.
 */
export class AcpDriver implements Driver {
  readonly kind: DriverKind

  constructor(
    kind: DriverKind,
    private readonly launch: AcpLaunch | null,
    private readonly fallback: Driver | null,
    /** Notified whenever the agent refuses for want of a login. */
    private readonly onAuthRequired: AcpAuthRequiredHandler | null = null,
  ) {
    this.kind = kind
  }

  async create(session: AdapterSession): Promise<ProviderAdapter> {
    if (this.launch !== null) {
      try {
        const adapter = await createAcpAdapter(
          this.launch,
          session,
          undefined,
          this.onAuthRequired ?? undefined,
        )
        log.info('turn started over ACP', { kind: this.kind, launch: this.launch.label })
        return adapter
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        log.warn('ACP transport failed; using legacy CLI driver', {
          kind: this.kind,
          error: String(error instanceof Error ? error.message : error),
        })
      }
    }
    if (this.fallback === null) {
      throw new Error(`no transport available for ${this.kind}`)
    }
    return this.fallback.create(session)
  }
}

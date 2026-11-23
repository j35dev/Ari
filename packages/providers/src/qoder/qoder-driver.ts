import {
  query,
  qodercliAuth,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
  startDaemon,
  type Daemon,
} from '@qoder-ai/qoder-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { SlashCommand } from '@ari/contracts/slash-commands'
import type { AdapterSession, Driver, ProviderAdapter, AdapterApprovalDecision } from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { AsyncQueue } from '../claude/async-queue'
import { ClaudeSessionPool } from '../claude/session-pool'
import type { ClaudeSessionProcess } from '../claude/session'
import { loadImageData, missingImagesNote } from '../attachments'
import { claudeSlashCommands } from '../slash-commands'
import {
  parseAskUserQuestions,
  encodeQuestionnaire,
  parseElicitationForm,
  replyElicitation,
  replyAskUser,
  replyPlanExit,
} from '../acp/client-requests'
import { QoderMessageMapper } from './mapper'

// Same bounded idle/reconnect lifecycle as the proven Claude SDK pool, in an independent pool.
export const qoderSessionPool = new ClaudeSessionPool()
const CAPABILITIES = {
  ...ONE_SHOT_PROVIDER_CAPABILITIES,
  steering: 'live',
  liveResponses: 'approvals-and-input',
  processContinuity: 'between-turns',
  terminalStatus: 'explicit',
  nativeChildren: {
    ...ONE_SHOT_PROVIDER_CAPABILITIES.nativeChildren,
    visibility: 'full',
    inspect: true,
    stop: true,
    approvals: true,
  },
} as const
export type QoderQuery = AsyncIterable<SDKMessage> &
  Pick<Query, 'initializationResult' | 'interrupt' | 'close'> &
  Partial<Pick<Query, 'supportedCommands' | 'stopTask'>>
export type QoderMcpServers = NonNullable<Options['mcpServers']>
export interface QoderDriverOptions {
  fallback?: Driver
  pool?: ClaudeSessionPool | null
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QoderQuery
  mcpServers?: (session: AdapterSession) => QoderMcpServers
  onAuthRequired?: () => void
  startDaemon?: typeof startDaemon
}

export function buildQoderOptions(session: AdapterSession, binary: string): Options {
  const env = session.runtimeEnv ?? { ...process.env }
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  return {
    auth: qodercliAuth(),
    cwd: session.workspacePath,
    pathToQoderCLIExecutable: binary,
    env,
    ...(proxy ? { proxy } : {}),
    ...(session.modelId && session.modelId !== 'default' ? { model: session.modelId } : {}),
    ...(session.resumeOf ? { resume: session.resumeOf } : {}),
    permissionMode:
      session.permissionMode === 'full'
        ? 'bypassPermissions'
        : session.permissionMode === 'allow-edits'
          ? 'acceptEdits'
          : 'default',
    ...(session.permissionMode === 'full' ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: true,
    includeShellProgress: true,
    settingSources: ['user', 'project', 'local'],
    ...(session.effort && session.effort !== 'default'
      ? {
          resolveModel: (context) =>
            context.purpose === 'main'
              ? { parameters: { reasoningEffort: session.effort! } }
              : undefined,
        }
      : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'qodercli',
      ...(session.instructions ? { append: session.instructions } : {}),
    },
  }
}
async function userMessage(
  text: string,
  attachments: NonNullable<AdapterSession['attachments']> = [],
): Promise<SDKUserMessage> {
  const { loaded, missing } = await loadImageData(attachments)
  const content: SDKUserMessage['message']['content'] = [
    { type: 'text', text: text + missingImagesNote(missing) },
    ...loaded.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mimeType as 'image/png',
        data: image.dataBase64,
      },
    })),
  ]
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }
}

function openSession(
  session: AdapterSession,
  options: Options,
  createQuery: NonNullable<QoderDriverOptions['query']>,
  stopDaemon?: () => Promise<void>,
): ClaudeSessionProcess {
  const input = new AsyncQueue<SDKUserMessage>()
  const mapper = new QoderMessageMapper()
  const pending = new Map<
    string,
    {
      resolve: (value: PermissionResult) => void
      name: string
      agentId?: string
      args: Record<string, unknown>
      suggestions?: Parameters<CanUseTool>[2]['suggestions']
      options?: Parameters<CanUseTool>[2]['permissionOptions']
      cleanup: () => void
    }
  >()
  const elicitation = new Map<string, { reply: (value: string) => void; cancel: () => void }>()
  const state: {
    turn: { events: AsyncQueue<AgentEvent>; interrupted: boolean } | null
    onEnded: ClaudeSessionProcess['onEnded']
  } = { turn: null, onEnded: null }
  let closed = false
  let ref = session.resumeOf
  let lastActivity = Date.now()
  let onBackground: ClaudeSessionProcess['onBackground'] = null
  const beforeTurn: AgentEvent[] = []
  const emit = (events: AgentEvent[]) => {
    lastActivity = Date.now()
    if (state.turn) events.forEach((event) => state.turn!.events.push(event))
    else if (onBackground) onBackground(events)
    else beforeTurn.push(...events)
  }
  const deny = (rootOnly = false) => {
    for (const [id, entry] of pending) {
      if (rootOnly && entry.agentId) continue
      pending.delete(id)
      entry.cleanup()
      entry.resolve({ behavior: 'deny', message: 'Qoder session interrupted or closed.' })
    }
    if (rootOnly) return
    for (const entry of elicitation.values()) entry.cancel()
    elicitation.clear()
  }
  const canUseTool: CanUseTool = (name, args, details) =>
    new Promise<PermissionResult>((resolve) => {
      if (closed || details.signal.aborted) {
        resolve({ behavior: 'deny', message: 'Qoder session closed.' })
        return
      }
      const id = `qoder-${randomUUID()}`
      const abort = () => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        entry.cleanup()
        resolve({ behavior: 'deny', message: 'Qoder request cancelled.' })
      }
      pending.set(id, {
        resolve,
        name,
        ...(details.agentID ? { agentId: details.agentID } : {}),
        args,
        suggestions: details.suggestions,
        options: details.permissionOptions,
        cleanup: () => details.signal.removeEventListener('abort', abort),
      })
      details.signal.addEventListener('abort', abort, { once: true })
      if (name === 'AskUserQuestion') {
        const questions = parseAskUserQuestions(args)
        emit([
          {
            type: 'input-requested',
            inputId: id,
            prompt: questions.map((question) => question.question).join('\n'),
            choicesJson: encodeQuestionnaire({ kind: 'questionnaire', questions }),
          },
        ])
      } else if (name === 'ExitPlanMode')
        emit([
          {
            type: 'input-requested',
            inputId: id,
            prompt: 'Approve this plan?',
            choicesJson: encodeQuestionnaire({
              kind: 'plan-approval',
              questions: [],
              ...(typeof args.plan === 'string' ? { planContent: args.plan } : {}),
            }),
          },
        ])
      else
        emit([
          {
            type: 'approval-requested',
            approvalId: id,
            toolName: name,
            summaryJson: JSON.stringify(args),
            providerItemId: details.toolUseID,
            ...(details.agentID
              ? { taskId: mapper.taskIdOf(details.agentID) ?? details.agentID }
              : {}),
            ...(ref ? { providerThreadId: ref } : {}),
            options: details.permissionOptions?.map((option) => ({
              optionId: option.outcome,
              name: option.name,
              kind: option.allowed
                ? option.outcome === 'proceed_once'
                  ? 'allow_once'
                  : 'allow_always'
                : 'reject_once',
            })) ?? [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'always-allow', name: 'Allow for this session', kind: 'allow_always' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        ])
    })
  const runtime = createQuery({
    prompt: input,
    options: {
      ...options,
      canUseTool,
      onElicitation: (request, details) =>
        new Promise((resolve) => {
          const id = `qoder-input-${randomUUID()}`
          const form = parseElicitationForm(request)
          const finish = (value: Awaited<ReturnType<NonNullable<Options['onElicitation']>>>) => {
            if (!elicitation.delete(id)) return
            details.signal.removeEventListener('abort', cancel)
            resolve(value)
          }
          const cancel = () => finish({ action: 'cancel' })
          elicitation.set(id, {
            reply: (value) =>
              finish(
                replyElicitation(form.questions, value) as Awaited<
                  ReturnType<NonNullable<Options['onElicitation']>>
                >,
              ),
            cancel,
          })
          details.signal.addEventListener('abort', cancel, { once: true })
          if (closed || details.signal.aborted || form.url) {
            cancel()
            return
          }
          emit([
            {
              type: 'input-requested',
              inputId: id,
              prompt: form.message,
              choicesJson: encodeQuestionnaire({
                kind: 'questionnaire',
                questions: form.questions,
              }),
            },
          ])
        }),
    },
  })
  let closing: Promise<void> | null = null
  const shutdown = () => {
    if (closing) return closing
    closed = true
    input.end()
    deny()
    state.turn?.events.end()
    state.turn = null
    closing = (async () => {
      try {
        await runtime.close()
      } finally {
        await stopDaemon?.()
      }
    })()
    return closing
  }
  const ready = runtime.initializationResult().then(async (initialization) => {
    if (
      initialization.permissionMode &&
      initialization.permissionMode !== options.permissionMode &&
      !(session.permissionMode === 'full' && initialization.permissionMode === 'yolo')
    )
      throw new Error('Qoder did not accept the requested permission mode.')
    if (runtime.supportedCommands)
      emit([{ type: 'commands', commands: claudeSlashCommands(await runtime.supportedCommands()) }])
  })
  // Start reading before the first input, but never submit it until the handshake succeeds.
  void (async () => {
    try {
      for await (const message of runtime) {
        if (closed) break
        if (message.session_id && !('parent_tool_use_id' in message && message.parent_tool_use_id))
          ref = message.session_id
        emit(mapper.map(message))
        if (message.type === 'result' && state.turn) {
          // Background agents can still await their own decisions after the
          // parent answers. Their native abort signals own cancellation.
          deny(true)
          state.turn.events.end()
          state.turn = null
        }
      }
      if (!closed && state.turn)
        emit([
          { type: 'error', message: 'Qoder SDK stream ended before its result.', rawJson: null },
          { type: 'done', stopReason: 'error' },
        ])
    } catch {
      if (!closed)
        emit([
          { type: 'error', message: 'Qoder SDK stream failed.', rawJson: null },
          { type: 'done', stopReason: 'error' },
        ])
    } finally {
      state.turn?.events.end()
      state.turn = null
      void shutdown()
      state.onEnded?.()
    }
  })()
  const respondApproval = (id: string, decision: AdapterApprovalDecision) => {
    const entry = pending.get(id)
    if (!entry) return
    let choice = typeof decision === 'object' ? decision.optionId : decision
    if (entry.options && typeof decision === 'string')
      choice =
        decision === 'allow'
          ? 'proceed_once'
          : decision === 'always-allow'
            ? 'proceed_always'
            : 'cancel'
    const offered = entry.options?.find((option) => option.outcome === choice)
    if (entry.options && !offered) return
    pending.delete(id)
    entry.cleanup()
    const allowed = offered
      ? offered.allowed
      : [
          'allow',
          'always-allow',
          'proceed_once',
          'proceed_always',
          'proceed_always_and_save',
        ].includes(choice)
    entry.resolve(
      allowed
        ? {
            behavior: 'allow',
            updatedInput: entry.args,
            permissionScope:
              choice === 'proceed_always_and_save'
                ? 'persist'
                : choice === 'always-allow' || choice === 'proceed_always'
                  ? 'session'
                  : 'once',
          }
        : { behavior: 'deny', message: 'Denied by user in Ari.' },
    )
  }
  const respondInput = (id: string, value: string) => {
    const form = elicitation.get(id)
    if (form) {
      form.reply(value)
      return
    }
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.cleanup()
    if (entry.name === 'AskUserQuestion') {
      const reply = replyAskUser(parseAskUserQuestions(entry.args), value) as {
        answers: Record<string, unknown>
      }
      entry.resolve({ behavior: 'allow', updatedInput: { ...entry.args, answers: reply.answers } })
    } else
      entry.resolve(
        (replyPlanExit(value) as { outcome?: string }).outcome === 'approved'
          ? { behavior: 'allow', updatedInput: entry.args }
          : { behavior: 'deny', message: 'Plan denied by user in Ari.' },
      )
  }
  const process: ClaudeSessionProcess = {
    transport: 'sdk',
    ready,
    get closed() {
      return closed
    },
    get sessionRef() {
      return ref
    },
    get lastActivity() {
      return lastActivity
    },
    get hasRunningTasks() {
      return [...mapper.tasks.values()].some((task) => task.event.status === 'running')
    },
    get hasPendingResponses() {
      return pending.size > 0 || elicitation.size > 0
    },
    get onBackground() {
      return onBackground
    },
    set onBackground(value) {
      onBackground = value
    },
    get onEnded() {
      return state.onEnded
    },
    set onEnded(value) {
      state.onEnded = value
    },
    shutdown,
    respondApproval,
    respondInput,
    stopSubagents: () => {
      if (!runtime.stopTask) return 0
      let count = 0
      for (const task of mapper.tasks.values())
        if (task.event.kind === 'subagent' && task.event.status === 'running' && task.nativeId) {
          count++
          void runtime.stopTask(task.nativeId).catch(() => {})
        }
      return count
    },
    beginTurn: (prompt, park, continuing) => {
      if (closed || state.turn) throw new Error('Qoder session is closed or already running.')
      mapper.beginTurn()
      const turn = { events: new AsyncQueue<AgentEvent>(), interrupted: false }
      state.turn = turn
      let parked = false
      beforeTurn.splice(0).forEach((event) => turn.events.push(event))
      if (ref) turn.events.push({ type: 'session-ref', ref })
      if (prompt) input.push(prompt as SDKUserMessage)
      return {
        start: () => turn.events,
        capabilities: () => ({
          ...CAPABILITIES,
          processContinuity: park ? 'between-turns' : 'turn-only',
        }),
        respondApproval,
        respondInput,
        continuesBackgroundWork: () => continuing === true,
        keepsBackgroundWork: () => parked,
        steer: async (text, attachments = []) => {
          if (closed || state.turn !== turn || turn.interrupted) return false
          const message = await userMessage(text, [...attachments])
          if (closed || state.turn !== turn || turn.interrupted) return false
          return input.push({ ...message, shouldQuery: false })
        },
        interrupt: () => {
          if (turn.interrupted || state.turn !== turn) return
          turn.interrupted = true
          deny()
          turn.events.push({ type: 'done', stopReason: 'interrupted' })
          turn.events.end()
          void runtime
            .interrupt()
            .catch(() => {})
            .finally(() => shutdown())
        },
        dispose: async () => {
          if (!turn.interrupted && !closed && state.turn !== turn && park?.()) {
            parked = true
            return
          }
          await shutdown()
        },
      }
    },
  }
  return process
}

export class QoderDriver implements Driver {
  readonly kind = 'qoder' as const
  readonly systemInstructions = true
  readonly #pool: ClaudeSessionPool | null
  constructor(
    private readonly binary: string,
    private readonly options: QoderDriverOptions = {},
  ) {
    this.#pool = options.pool === undefined ? qoderSessionPool : options.pool
  }
  capabilities() {
    return CAPABILITIES
  }
  hasLiveSession(id: string) {
    return this.#pool?.has(id) || this.options.fallback?.hasLiveSession?.(id) || false
  }
  listCommands(
    request: Parameters<NonNullable<Driver['listCommands']>>[0],
  ): Promise<SlashCommand[]> {
    return this.options.fallback?.listCommands?.(request) ?? Promise.resolve([])
  }
  async create(session: AdapterSession): Promise<ProviderAdapter> {
    const fallbackSession =
      session.instructions && !this.options.fallback?.systemInstructions
        ? { ...session, prompt: `${session.instructions}\n\n${session.prompt}`, instructions: null }
        : session
    if (this.options.fallback?.hasLiveSession?.(session.sessionId))
      return this.options.fallback.create(fallbackSession)
    const key = JSON.stringify([
      this.binary,
      session.workspacePath,
      session.modelId,
      session.permissionMode,
      session.effort,
      session.runtimeEnv,
    ])
    let process: ClaudeSessionProcess | null = null
    let daemon: Daemon | null = null
    try {
      const opts = {
        ...buildQoderOptions(session, this.binary),
        ...(this.options.mcpServers ? { mcpServers: this.options.mcpServers(session) } : {}),
        ...(this.options.onAuthRequired ? { onAuthExpired: this.options.onAuthRequired } : {}),
      }
      process = this.#pool?.take(session.sessionId, key, session.resumeOf) ?? null
      const continuing = process !== null
      if (!process) {
        // SDK's implicit daemon is process-wide. Own it per parked session so
        // account credentials and environment never bleed between sessions.
        if (!this.options.query || this.options.startDaemon)
          daemon = await (this.options.startDaemon ?? startDaemon)({
            auth: { type: 'qodercli' },
            pathToQoderCLIExecutable: this.binary,
            env: opts.env,
            ...(opts.proxy ? { proxy: opts.proxy } : {}),
            ...((opts.env?.NO_PROXY ?? opts.env?.no_proxy)
              ? { noProxy: opts.env?.NO_PROXY ?? opts.env?.no_proxy }
              : {}),
          })
        const owned = daemon
        const queryOptions: Options = { ...opts, ...(owned ? { daemon: owned } : {}) }
        if (owned) {
          // These are daemon process options, not Session overrides.
          delete queryOptions.auth
          delete queryOptions.env
          delete queryOptions.pathToQoderCLIExecutable
          delete queryOptions.proxy
        }
        process = openSession(
          session,
          queryOptions,
          this.options.query ?? query,
          owned ? () => owned.stop() : undefined,
        )
      }
      await process.ready
      const activeProcess = process
      const prompt = await userMessage(session.prompt, session.attachments)
      return activeProcess.beginTurn(
        prompt,
        this.#pool ? () => this.#pool!.put(session.sessionId, key, activeProcess) : undefined,
        continuing,
      )
    } catch (error) {
      await process?.shutdown()
      if (!process) await daemon?.stop()
      // Only initialization/attachment preparation reaches here. No user prompt
      // has been submitted, so compatibility fallback cannot execute it twice.
      if (this.options.fallback) return this.options.fallback.create(fallbackSession)
      throw error
    }
  }
}

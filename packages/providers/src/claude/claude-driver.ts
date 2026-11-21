import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { createLogger } from '@ari/shared/logger'
import type { AdapterApprovalDecision, AdapterSession, Driver, ProviderAdapter } from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { loadImageData, missingImagesNote, stagedImagesOf } from '../attachments'
import { teardownChild } from '../teardown'
import { parseAskUserQuestions, encodeQuestionnaire, replyAskUser } from '../acp/client-requests'
import { parsePlanExit, replyPlanExit } from '../acp/client-requests'
import { parseElicitationForm, replyElicitation } from '../acp/client-requests'
import type { ElicitationResult } from '@anthropic-ai/claude-agent-sdk'
import { ACP_PROVIDER_DEFAULT_EFFORT } from '../acp/thought'
import { resolveOfferedModel } from '../catalogs'
import { AsyncQueue } from './async-queue'
import { ClaudeBackgroundTasks } from './background-tasks'
import { CLAUDE_APPROVAL_OPTIONS, ClaudeMessageMapper, type NativeLine } from './mapper'
import { claudeSdkExecutable } from './executable'
import { claudeSessionPool, type ClaudeSessionPool } from './session-pool'
import type { ClaudeSessionProcess } from './session'

// Retain the old transport for explicit rollback and the JSONL fixture recorder.
export { ClaudeCliDriver, argvSafeText, buildClaudeArgs, buildUserFrame } from './cli-driver'
export { claudeSessionPool, ClaudeSessionPool } from './session-pool'

const log = createLogger('providers:claude-sdk')
const CAPABILITIES = {
  ...ONE_SHOT_PROVIDER_CAPABILITIES,
  steering: 'live',
  liveResponses: 'approvals-and-input',
  nativeChildren: {
    ...ONE_SHOT_PROVIDER_CAPABILITIES.nativeChildren,
    visibility: 'lifecycle',
    approvals: true,
  },
  processContinuity: 'between-turns',
  terminalStatus: 'explicit',
} as const

/** Small SDK seam: test streams need not implement unrelated query control methods. */
export type ClaudeQuery = AsyncIterable<SDKMessage> &
  Pick<Query, 'interrupt' | 'close'> &
  Partial<
    Pick<
      Query,
      | 'initializationResult'
      | 'setModel'
      | 'stopTask'
      | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
    >
  >
export type ClaudeMcpServers = NonNullable<Options['mcpServers']>
export interface ClaudeDriverOptions {
  /** Roll back only failures before any prompt is submitted. */
  fallback?: Driver
  pool?: ClaudeSessionPool | null
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery
  mcpServers?: (session: AdapterSession) => ClaudeMcpServers
  onAuthRequired?: (wall: {
    label: string
    logins: {
      methodId: string
      name: string
      description: string
      command: string
      args: string[]
    }[]
  }) => void
}

function sdkMode(mode: AdapterSession['permissionMode']): NonNullable<Options['permissionMode']> {
  return mode === 'full' ? 'bypassPermissions' : mode === 'allow-edits' ? 'acceptEdits' : 'default'
}

export function buildClaudeOptions(session: AdapterSession, binaryPath: string): Options {
  return {
    cwd: session.workspacePath,
    pathToClaudeCodeExecutable: claudeSdkExecutable(binaryPath),
    ...(session.modelId && session.modelId !== 'default' ? { model: session.modelId } : {}),
    // The installed harness/catalog owns supported effort values, including newer levels.
    ...(session.effort && session.effort !== ACP_PROVIDER_DEFAULT_EFFORT
      ? { effort: session.effort as Options['effort'] }
      : {}),
    ...(session.resumeOf ? { resume: session.resumeOf } : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(session.instructions ? { append: session.instructions } : {}),
    },
    settingSources: ['user', 'project', 'local'],
    permissionMode: sdkMode(session.permissionMode),
    ...(session.permissionMode === 'full' ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: true,
    env: session.runtimeEnv ?? { ...process.env },
  }
}

export function buildClaudeUserMessage(
  text: string,
  images: { dataBase64: string; mimeType: string }[] = [],
): SDKUserMessage {
  const content: unknown[] = []
  if (text) content.push({ type: 'text', text })
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 },
    })
  }
  return {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: null,
    session_id: '',
    uuid: randomUUID(),
  }
}

interface PendingPermission {
  toolName: string
  input: Record<string, unknown>
  suggestions: Parameters<CanUseTool>[2]['suggestions']
  finish: (result: PermissionResult) => void
}
interface Turn {
  events: AsyncQueue<AgentEvent>
  uuids: Set<string>
  completed: boolean
  interrupted: boolean
}

/** Owns one query and reader across results. A turn never awaits query teardown. */
function openClaudeSession(
  session: AdapterSession,
  options: Options,
  createQuery: NonNullable<ClaudeDriverOptions['query']>,
  onAuthRequired?: ClaudeDriverOptions['onAuthRequired'],
): ClaudeSessionProcess {
  const input = new AsyncQueue<SDKUserMessage>()
  const mapper = new ClaudeMessageMapper()
  const tasks = new ClaudeBackgroundTasks()
  const permissions = new Map<string, PendingPermission>()
  const startupEvents: AgentEvent[] = []
  const inputs = new Map<string, { reply: (value: string) => void; cancel: () => void }>()
  const children: ChildProcessWithoutNullStreams[] = []
  const treeKills = new Set<Promise<void>>()
  let active: Turn | null = null
  let stoppingSubagents = false
  let closed = false
  let sessionRef: string | null = session.resumeOf
  let lastActivity = Date.now()
  let interruptFallback: ReturnType<typeof setTimeout> | null = null
  let autonomousRunning = false
  let reportedBackgroundWork = false
  let streamIsAutonomous = false
  let backgroundHandler: ClaudeSessionProcess['onBackground'] = null
  let endedHandler: ClaudeSessionProcess['onEnded'] = null
  const pendingBackground: AgentEvent[] = []

  const emit = (events: AgentEvent[], turn = active): void => {
    lastActivity = Date.now()
    if (turn) for (const event of events) turn.events.push(event)
    else if (backgroundHandler) backgroundHandler(events)
    else pendingBackground.push(...events)
  }
  const denyPending = (): void => {
    for (const pending of [...permissions.values()])
      pending.finish({ behavior: 'deny', message: 'Claude turn ended or was interrupted.' })
    for (const input of [...inputs.values()]) input.cancel()
  }
  function waitForInput<T>(
    event: Extract<AgentEvent, { type: 'input-requested' }>,
    signal: AbortSignal,
    reply: (value: string) => T,
    cancelled: T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const abort = (): void => finish(cancelled)
      const finish = (answer: T): void => {
        if (!inputs.delete(event.inputId)) return
        signal.removeEventListener('abort', abort)
        resolve(answer)
      }
      inputs.set(event.inputId, { reply: (value) => finish(reply(value)), cancel: abort })
      signal.addEventListener('abort', abort, { once: true })
      if (closed || signal.aborted) {
        abort()
        return
      }
      emit([event])
    })
  }
  const clearInterruptFallback = (): void => {
    if (interruptFallback) clearTimeout(interruptFallback)
    interruptFallback = null
  }
  const canUseTool: CanUseTool = (toolName, toolInput, callback) => {
    if (closed || callback.signal.aborted)
      return Promise.resolve({ behavior: 'deny', message: 'Claude session closed.' })
    const id = `claude-${randomUUID()}`
    return new Promise<PermissionResult>((resolve) => {
      const abort = (): void =>
        finish({ behavior: 'deny', message: 'Claude permission request cancelled.' })
      const finish = (result: PermissionResult): void => {
        if (!permissions.delete(id)) return
        callback.signal.removeEventListener('abort', abort)
        resolve(result)
      }
      permissions.set(id, { toolName, input: toolInput, suggestions: callback.suggestions, finish })
      callback.signal.addEventListener('abort', abort, { once: true })
      if (callback.signal.aborted) {
        abort()
        return
      }
      if (toolName === 'ExitPlanMode') {
        const planContent =
          typeof toolInput['plan'] === 'string'
            ? toolInput['plan']
            : parsePlanExit(toolInput).planContent
        emit([
          {
            type: 'input-requested',
            inputId: id,
            prompt: 'Approve this plan?',
            choicesJson: encodeQuestionnaire({ kind: 'plan-approval', questions: [], planContent }),
          },
        ])
      } else if (toolName === 'AskUserQuestion') {
        const questions = parseAskUserQuestions(toolInput)
        emit([
          {
            type: 'input-requested',
            inputId: id,
            prompt: questions.map((q) => q.question).join('\n'),
            choicesJson: encodeQuestionnaire({ kind: 'questionnaire', questions }),
          },
        ])
      } else {
        emit([
          {
            type: 'approval-requested',
            approvalId: id,
            toolName,
            summaryJson: JSON.stringify(toolInput),
            options: [...CLAUDE_APPROVAL_OPTIONS],
            ...(sessionRef ? { providerThreadId: sessionRef } : {}),
            providerItemId: callback.toolUseID,
          },
        ])
      }
    })
  }

  const runtime = createQuery({
    prompt: input,
    options: {
      ...options,
      canUseTool,
      onElicitation: (request, callback) => {
        const form = parseElicitationForm(request)
        if (form.url) return Promise.resolve({ action: 'cancel' as const })
        return waitForInput<ElicitationResult>(
          {
            type: 'input-requested',
            inputId: `claude-${randomUUID()}`,
            prompt: form.message || form.questions[0]?.question || 'Question',
            choicesJson: encodeQuestionnaire({ kind: 'questionnaire', questions: form.questions }),
          },
          callback.signal,
          (value) => replyElicitation(form.questions, value) as ElicitationResult,
          { action: 'cancel' },
        )
      },
      stderr: (text) => log.debug('claude stderr', { text: text.slice(0, 500) }),
      // Capture the actual CLI child. Windows kills must reach its tool/MCP descendants
      // before TerminateProcess loses the ancestry needed by taskkill /T.
      spawnClaudeCodeProcess: (spawnOptions) => {
        const isJs = /\.[cm]?js$/i.test(options.pathToClaudeCodeExecutable ?? '')
        const child = spawn(isJs ? process.execPath : spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: { ...spawnOptions.env, ...(isJs ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        if (process.platform === 'win32') {
          const kill = child.kill.bind(child)
          child.kill = (signal) => {
            if (child.exitCode !== null || child.signalCode !== null) return false
            if (!child.pid) return kill(signal)
            const killing = new Promise<void>((resolve) => {
              const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                windowsHide: true,
              })
              killer.once('error', () => {
                kill(signal)
                resolve()
              })
              killer.once('exit', (code) => {
                if (code !== 0) kill(signal)
                resolve()
              })
            })
            treeKills.add(killing)
            void killing.then(() => treeKills.delete(killing))
            return true
          }
        }
        children.push(child)
        return child
      },
    },
  })

  async function pump(): Promise<void> {
    try {
      for await (const message of runtime) {
        const native = message as unknown as NativeLine
        if (
          native.type === 'system' &&
          native.subtype === 'background_tasks_changed' &&
          Array.isArray(native.tasks)
        )
          reportedBackgroundWork = native.tasks.length > 0
        if (native.type === 'system' && native.subtype === 'init')
          sessionRef = native.session_id ?? sessionRef
        const turn = active
        // Autonomous task notifications and stale results must not settle a newly submitted turn.
        const ids = [
          ...(native.user_message_uuids ?? []),
          ...(native.user_message_uuid ? [native.user_message_uuid] : []),
        ]
        if (ids.length > 0) streamIsAutonomous = !turn || !ids.some((id) => turn.uuids.has(id))
        else if (native.origin) streamIsAutonomous = native.origin.kind !== 'human'
        const otherTurn = !!turn && streamIsAutonomous
        const target = otherTurn ? null : turn
        if (!target && (native.type === 'assistant' || native.type === 'stream_event'))
          autonomousRunning = true
        const events = [...tasks.observe(native), ...mapper.map(message)]
        if (native.type === 'result' && target?.interrupted) {
          for (const event of events) if (event.type === 'done') event.stopReason = 'interrupted'
        }
        if (stoppingSubagents && native.type === 'system' && native.subtype === 'task_started') {
          const late = tasks.interruptSubagents()
          events.push(...late.events)
          for (const taskId of late.nativeIds) {
            void runtime.stopTask?.(taskId).catch((error: unknown) => {
              log.warn('Claude late subagent stop failed; closing its query', {
                error: String(error),
              })
              void shutdown()
            })
          }
        }
        if (
          events.some(
            (event) =>
              event.type === 'error' &&
              /authentication_failed|not logged in|invalid.*(?:token|key)|token.*expired|unauthenticated|authentication.*(?:expired|required)|login required|please.*log.?in|401/i.test(
                event.message,
              ),
          )
        ) {
          onAuthRequired?.({
            label: 'Claude Code',
            logins: [
              {
                methodId: 'claude-login',
                name: 'Claude Code',
                description: 'Sign in with your existing Claude Code account.',
                command: options.pathToClaudeCodeExecutable!,
                args: ['auth', 'login'],
              },
            ],
          })
        }
        emit(events, target)
        if (native.type === 'result' && !target) autonomousRunning = false
        if (native.type === 'result' && target) {
          clearInterruptFallback()
          target.completed = true
          target.events.end()
          active = null
        }
      }
      if (!closed && active)
        emit([
          { type: 'error', message: 'Claude SDK stream ended before a result.', rawJson: null },
          { type: 'done', stopReason: 'error' },
        ])
    } catch (error) {
      if (!closed)
        emit([
          { type: 'error', message: `Claude SDK stream failed: ${String(error)}`, rawJson: null },
          { type: 'done', stopReason: 'error' },
        ])
    } finally {
      clearInterruptFallback()
      closed = true
      input.end()
      denyPending()
      active?.events.end()
      active = null
      void shutdown()
      endedHandler?.()
    }
  }
  let shuttingDown: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown
    closed = true
    clearInterruptFallback()
    input.end()
    denyPending()
    active?.events.end()
    active = null
    try {
      runtime.close()
    } catch (error) {
      log.warn('claude query close failed', { error: String(error) })
    }
    shuttingDown = Promise.all(children.map((child) => teardownChild(child))).then(async () => {
      await Promise.all(treeKills)
    })
    return shuttingDown
  }
  const controls = {
    respondApproval: (id: string, decision: AdapterApprovalDecision): void => {
      const pending = permissions.get(id)
      if (!pending) return
      const choice = typeof decision === 'object' ? decision.optionId : decision
      if (choice !== 'allow' && choice !== 'always-allow') {
        pending.finish({ behavior: 'deny', message: 'Denied by user in Ari.' })
        return
      }
      const updates =
        pending.toolName === 'ExitPlanMode'
          ? [
              {
                type: 'setMode' as const,
                mode: sdkMode(session.permissionMode),
                destination: 'session' as const,
              },
            ]
          : choice === 'always-allow'
            ? pending.suggestions?.length
              ? pending.suggestions.map((suggestion) => ({
                  ...suggestion,
                  destination: 'session' as const,
                }))
              : [
                  {
                    type: 'addRules' as const,
                    rules: [{ toolName: pending.toolName }],
                    behavior: 'allow' as const,
                    destination: 'session' as const,
                  },
                ]
            : undefined
      pending.finish({
        behavior: 'allow',
        updatedInput: pending.input,
        ...(updates ? { updatedPermissions: updates } : {}),
      })
    },
    respondInput: (id: string, value: string): void => {
      const input = inputs.get(id)
      if (input) {
        input.reply(value)
        return
      }
      const pending = permissions.get(id)
      if (pending?.toolName === 'ExitPlanMode') {
        const answer = replyPlanExit(value) as { outcome: string; feedback?: string }
        if (answer.outcome === 'approved') controls.respondApproval(id, 'allow')
        else
          pending.finish({
            behavior: 'deny',
            message:
              answer.feedback ??
              (answer.outcome === 'abandoned'
                ? 'The user abandoned this plan.'
                : 'The user requested changes to the plan.'),
            ...(answer.outcome === 'abandoned' ? { interrupt: true } : {}),
          })
        return
      }
      if (pending?.toolName !== 'AskUserQuestion') return
      const answer = replyAskUser(parseAskUserQuestions(pending.input), value) as {
        answers: Record<string, unknown>
      }
      pending.finish({
        behavior: 'allow',
        updatedInput: {
          ...pending.input,
          answers: Object.fromEntries(
            Object.entries(answer.answers).map(([question, value]) => [
              question,
              Array.isArray(value) ? value.join(', ') : value,
            ]),
          ),
        },
      })
    },
  }
  const ready = (async () => {
    const initialization = await runtime.initializationResult?.()
    if (session.modelId && session.modelId !== 'default' && initialization?.models?.length) {
      const offered = resolveOfferedModel(
        session.modelId,
        initialization.models.map((model) => ({
          id: model.value,
          label: model.displayName,
          aliases: model.resolvedModel ? [model.resolvedModel] : [],
        })),
      )
      if (offered !== session.modelId) {
        if (!runtime.setModel) throw new Error('Claude SDK cannot apply the requested model')
        await runtime.setModel(offered ?? undefined)
      }
      if (offered === null) {
        const fallback =
          initialization.models.find((model) => model.value === 'default')?.resolvedModel ??
          'the CLI default model'
        startupEvents.push({
          type: 'notice',
          message: `"${session.modelId}" is not offered by this agent, so this turn ran on ${fallback}.`,
        })
      }
    }
    if (session.resumeOf && runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) {
      const usage = await runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      })
      mapper.seedUsage(usage.session.total_cost_usd, usage.session.model_usage)
    }
  })()
  // The driver awaits readiness before submitting prompt bytes; keep rejection handled
  // while the stream pump is still reporting the same startup failure.
  void ready.catch(() => undefined)
  void pump().catch((error: unknown) =>
    log.warn('claude query cleanup failed', { error: String(error) }),
  )
  return {
    transport: 'sdk',
    ready,
    ...controls,
    get closed() {
      return closed
    },
    get sessionRef() {
      return sessionRef
    },
    get lastActivity() {
      return lastActivity
    },
    get hasRunningTasks() {
      return (
        tasks.running().length > 0 ||
        permissions.size > 0 ||
        inputs.size > 0 ||
        autonomousRunning ||
        reportedBackgroundWork
      )
    },
    get hasPendingResponses() {
      return permissions.size > 0 || inputs.size > 0
    },
    get onBackground() {
      return backgroundHandler
    },
    set onBackground(handler) {
      backgroundHandler = handler
      if (handler && pendingBackground.length > 0) handler(pendingBackground.splice(0))
    },
    get onEnded() {
      return endedHandler
    },
    set onEnded(handler) {
      endedHandler = handler
    },
    shutdown,
    beginTurn: (prompt, park, continuing = false) => {
      if (closed || active) throw new Error('Claude query is unavailable for a new turn')
      const turn: Turn = {
        events: new AsyncQueue(),
        uuids: new Set(),
        completed: false,
        interrupted: false,
      }
      active = turn
      stoppingSubagents = false
      streamIsAutonomous = autonomousRunning
      backgroundHandler = null
      endedHandler = null
      for (const task of tasks.running()) turn.events.push(task)
      for (const event of startupEvents.splice(0)) turn.events.push(event)
      if (sessionRef) turn.events.push({ type: 'session-ref', ref: sessionRef })
      // A resumed CLI can replay a pending question before the first prompt.
      // Surface those callbacks immediately once the host has its turn adapter.
      for (const event of pendingBackground.splice(0)) {
        if (event.type === 'approval-requested') {
          if (permissions.has(event.approvalId)) turn.events.push(event)
        } else if (event.type === 'input-requested') {
          if (permissions.has(event.inputId) || inputs.has(event.inputId)) turn.events.push(event)
        } else if (event.type !== 'session-ref') pendingBackground.push(event)
      }
      const submit = (message: SDKUserMessage): boolean => {
        if (message.uuid) turn.uuids.add(message.uuid)
        return input.push(message)
      }
      if (prompt) submit(prompt as SDKUserMessage)
      let parked = false
      return {
        ...controls,
        capabilities: () => ({
          ...CAPABILITIES,
          processContinuity: park ? 'between-turns' : 'turn-only',
        }),
        start: () => turn.events,
        continuesBackgroundWork: () => continuing,
        keepsBackgroundWork: () => parked,
        steer: async (text, attachments = []) => {
          if (active !== turn || turn.interrupted || (!text && attachments.length === 0))
            return false
          const { loaded, missing } = await loadImageData([...attachments])
          return (
            active === turn &&
            !turn.interrupted &&
            submit(buildClaudeUserMessage(text + missingImagesNote(missing), loaded))
          )
        },
        interrupt: () => {
          if (active !== turn || turn.interrupted) return
          turn.interrupted = true
          stoppingSubagents = true
          denyPending()
          const subagents = tasks.interruptSubagents()
          emit(subagents.events, turn)
          for (const taskId of subagents.nativeIds) {
            void runtime.stopTask?.(taskId).catch((error: unknown) => {
              log.warn('Claude subagent stop failed; closing its query', { error: String(error) })
              emit([{ type: 'done', stopReason: 'interrupted' }], turn)
              turn.events.end()
              void shutdown()
            })
          }
          // A crashed/hung CLI can acknowledge interrupt without delivering result.
          // Wake the turn before cleanup; quit must never wait forever on that stream.
          interruptFallback = setTimeout(() => {
            interruptFallback = null
            if (active !== turn || turn.completed) return
            emit([{ type: 'done', stopReason: 'interrupted' }], turn)
            turn.events.end()
            active = null
            void shutdown()
          }, 2_000)
          void runtime
            .interrupt()
            .then((receipt) => {
              const queuedInputSurvived =
                receipt?.still_queued.some((id) => turn.uuids.has(id)) ?? turn.uuids.size > 1
              if (!queuedInputSurvived) return
              // The public SDK interrupt cannot cancel queued input. Closing this
              // query preserves Ari's Stop behavior for already accepted steering.
              emit([{ type: 'done', stopReason: 'interrupted' }], turn)
              turn.events.end()
              void shutdown()
            })
            .catch((error: unknown) => {
              emit(
                [
                  {
                    type: 'error',
                    message: `Claude interrupt failed: ${String(error)}`,
                    rawJson: null,
                  },
                  { type: 'done', stopReason: 'error' },
                ],
                turn,
              )
              turn.events.end()
              void shutdown()
            })
        },
        dispose: async () => {
          if (turn.completed && !closed && park?.()) {
            parked = true
            return
          }
          await shutdown()
        },
      }
    },
  }
}

export class ClaudeDriver implements Driver {
  readonly kind = 'claude' as const
  readonly systemInstructions = true
  constructor(
    private readonly binaryPath: string,
    private readonly options: ClaudeDriverOptions = {},
  ) {}
  capabilities() {
    return {
      ...CAPABILITIES,
      processContinuity: this.options.pool === null ? 'turn-only' : 'between-turns',
    } as const
  }
  hasLiveSession(sessionId: string): boolean {
    return (
      (this.options.pool === undefined ? claudeSessionPool : this.options.pool)?.hasTransport(
        sessionId,
        'sdk',
      ) ?? false
    )
  }
  async create(session: AdapterSession): Promise<ProviderAdapter> {
    if (
      !this.hasLiveSession(session.sessionId) &&
      this.options.fallback?.hasLiveSession?.(session.sessionId)
    )
      return this.options.fallback.create(session)
    try {
      return await this.createSdk(session)
    } catch (error) {
      if (
        !this.options.fallback ||
        /authentication|log.?in|sign.?in|credential|token.*expired/i.test(String(error))
      )
        throw error
      log.warn(
        'Claude SDK startup failed before prompt submission; using compatibility transport',
        { error: String(error) },
      )
      return this.options.fallback.create(session)
    }
  }
  private async createSdk(session: AdapterSession): Promise<ProviderAdapter> {
    const pool = this.options.pool === undefined ? claudeSessionPool : this.options.pool
    const options = buildClaudeOptions(session, this.binaryPath)
    const mcpServers = this.options.mcpServers?.(session)
    const key = JSON.stringify([
      'sdk',
      this.binaryPath,
      session.workspacePath,
      session.modelId,
      session.effort ?? null,
      session.permissionMode,
      session.instructions ?? null,
      session.runtimeEnv ?? null,
      mcpServers ?? null,
    ])
    const reused = pool?.take(session.sessionId, key, session.resumeOf) ?? null
    const { loaded, missing } = await loadImageData(stagedImagesOf(session))
    const process =
      reused ??
      openClaudeSession(
        session,
        { ...options, ...(mcpServers ? { mcpServers } : {}) },
        this.options.query ?? query,
        this.options.onAuthRequired
          ? (wall) =>
              this.options.onAuthRequired?.({
                ...wall,
                logins: wall.logins.map((login) => ({ ...login, command: this.binaryPath })),
              })
          : undefined,
      )
    try {
      await process.ready
      return process.beginTurn(
        buildClaudeUserMessage(session.prompt + missingImagesNote(missing), loaded),
        pool ? () => pool.put(session.sessionId, key, process) : undefined,
        reused !== null,
      )
    } catch (error) {
      await process.shutdown()
      throw error
    }
  }
}

/** Read-only SDK control queries: no prompt, no model tokens, no ACP process. */
export async function withClaudeQuery<T>(
  binaryPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
  operation: (runtime: Query) => Promise<T>,
  timeoutMs = 45_000,
): Promise<T> {
  let runtime!: Query
  const session: AdapterSession = {
    sessionId: 'claude-probe',
    workspacePath: cwd,
    runtimeEnv: env,
    prompt: '',
    modelId: null,
    permissionMode: 'ask',
    resumeOf: null,
  }
  const process = openClaudeSession(
    session,
    {
      ...buildClaudeOptions(session, binaryPath),
      tools: [],
      strictMcpConfig: true,
      mcpServers: {},
    },
    (input) => {
      runtime = query(input)
      return runtime
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(runtime),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Claude SDK probe timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    await process.shutdown()
  }
}

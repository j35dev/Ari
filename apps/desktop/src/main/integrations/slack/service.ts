import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SecretBox } from '@ari/ari-core/endpoints'
import {
  externalIntent,
  externalThreadKey,
  type ExternalRequest,
  type ExternalSource,
} from '@ari/contracts/external'
import {
  slackConfigureSchema,
  type SlackConfigure,
  type SlackMutationResult,
  type SlackSnapshot,
} from '@ari/contracts/slack'
import { parseQuestionPayload, encodeAnswers } from '@ari/contracts/questions'
import {
  ExternalTaskError,
  type ExternalTaskHost,
  type ExternalPendingRequest,
} from '../../external/task-host'
import {
  SlackStore,
  type SlackBinding,
  type SlackCallback,
  type SlackStoredRequest,
  type SlackState,
  type SlackOutbound,
} from './store'
import {
  createSlackTransport,
  SlackTransportError,
  type SlackEnvelope,
  type SlackTransport,
  type SlackReply,
} from './transport'
import {
  questionAnswer,
  questionModal,
  SlackFormError,
  slackHelp,
  slackPlain,
  statusText,
  resultReply,
} from './messages'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identifier = z.string().min(1).max(200)
const mentionSchema = z.object({
  type: z.literal('event_callback'),
  team_id: identifier,
  api_app_id: identifier,
  event_id: identifier,
  event: z.object({
    type: z.literal('app_mention'),
    user: identifier.optional(),
    channel: identifier,
    text: z.string().max(16_000),
    ts: z.string().regex(/^\d+\.\d+$/),
    thread_ts: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
    subtype: z.string().optional(),
    bot_id: z.string().optional(),
  }),
})
const actionSchema = z.object({
  type: z.literal('block_actions'),
  team: z.object({ id: identifier }),
  user: z.object({ id: identifier }),
  channel: z.object({ id: identifier }),
  message: z.object({ ts: identifier, thread_ts: identifier.optional() }),
  trigger_id: z.string().max(300),
  actions: z
    .array(
      z.object({
        action_id: identifier,
        value: z.string().max(2000),
        action_ts: identifier.optional(),
      }),
    )
    .min(1)
    .max(5),
})
const submissionSchema = z.object({
  type: z.literal('view_submission'),
  team: z.object({ id: identifier }),
  user: z.object({ id: identifier }),
  view: z.object({
    id: identifier,
    callback_id: z.literal('ari_question'),
    private_metadata: identifier,
    state: z.object({ values: z.record(z.string(), z.unknown()) }),
  }),
})

export interface SlackServiceDeps {
  path: string
  secrets: () => SecretBox | null
  host: ExternalTaskHost
  transport?: (botToken: string, appToken: string) => SlackTransport
  onChanged?: (snapshot: SlackSnapshot) => void
  postIntervalMs?: number
}

/** One explicitly authorized Slack installation driving ordinary project sessions. */
export class SlackService {
  readonly store: SlackStore
  readonly ready: Promise<void>
  #transport: SlackTransport | null = null
  #generation = 0
  #status: SlackSnapshot['status'] = 'disconnected'
  #message: string | null = null
  #recordError = false
  #closed = false
  #jobs = new Map<string, Promise<void>>()
  #scheduled = new Set<string>()
  #background = new Set<Promise<void>>()
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #pumpTimer: ReturnType<typeof setTimeout> | undefined
  #pumping = false
  #refreshing: Promise<void> | null = null
  #refreshFollowUp: Promise<void> | null = null
  #nextPostAt = 0
  #off: (() => void) | null = null
  #lifecycle: Promise<unknown> = Promise.resolve()

  constructor(readonly deps: SlackServiceDeps) {
    this.store = new SlackStore(deps.path)
    this.ready = this.#initialize()
  }

  async #initialize(): Promise<void> {
    try {
      await this.store.load()
      await this.store.update((state) => {
        for (const entry of Object.values(state.outbox))
          if (entry.state === 'sending') entry.state = 'uncertain'
      })
    } catch {
      this.#recordError = true
      this.#status = 'error'
      this.#message =
        'Slack connection records could not be read or saved. Forget this connection explicitly before setting it up again.'
    }
  }

  async snapshot(): Promise<SlackSnapshot> {
    await this.ready
    const state = this.store.state
    return {
      status: this.#status,
      message: this.#message,
      enabled: state.enabled,
      hasCredentials: state.secrets !== null,
      secureStorageAvailable: this.deps.secrets() !== null,
      workspace: state.connection
        ? {
            id: state.connection.workspaceId,
            name: state.connection.workspaceName,
            botUserId: state.connection.botUserId,
          }
        : null,
      ownerUserId: state.connection?.ownerUserId ?? '',
      permissionMode: state.connection?.permissionMode ?? 'ask',
      routes: state.connection?.routes.map((route) => ({ ...route })) ?? [],
      projects: await this.deps.host.projects().catch(() => []),
      providers: await this.deps.host.catalog().catch(() => []),
      taskCount: Object.values(state.bindings).filter((binding) => this.#bindingScoped(binding))
        .length,
      uncertainRequests: Object.values(state.requests).filter(
        (request) => request.phase === 'uncertain',
      ).length,
      uncertainDeliveries: Object.values(state.outbox).filter(
        (entry) => entry.state === 'uncertain',
      ).length,
    }
  }

  startSaved(): Promise<void> {
    return this.#serialize(async () => {
      await this.ready
      if (this.#recordError || !this.store.state.enabled || this.#closed) return
      const credentials = this.#credentials()
      if (!credentials) {
        this.#status = 'error'
        this.#message = 'The saved Slack tokens could not be decrypted. Reconnect with new tokens.'
        await this.#publish()
        return
      }
      await this.#connect(credentials.bot, credentials.app)
    })
  }

  configure(params: SlackConfigure): Promise<SlackMutationResult> {
    const generation = ++this.#generation
    return this.#serialize(async () => {
      await this.ready
      try {
        if (this.#closed) throw new ExternalTaskError('closed', 'Ari is shutting down.')
        if (this.#recordError)
          throw new ExternalTaskError(
            'records_unavailable',
            this.#message ?? 'Slack records are unavailable.',
          )
        const parsed = slackConfigureSchema.safeParse(params)
        if (!parsed.success)
          throw new ExternalTaskError(
            'invalid_configuration',
            'Enter valid Slack tokens, your member ID, and a unique channel ID for each project mapping.',
          )
        params = parsed.data
        if (generation !== this.#generation)
          throw new ExternalTaskError(
            'superseded',
            'A newer connection action replaced this request.',
          )
        const box = this.deps.secrets()
        if (!box)
          throw new ExternalTaskError(
            'secure_storage_unavailable',
            'OS-backed secure storage is unavailable. Unlock your system keyring before connecting Slack.',
          )
        const saved = this.#credentials()
        const botToken = params.botToken ?? saved?.bot
        const appToken = params.appToken ?? saved?.app
        if (!botToken || !appToken)
          throw new ExternalTaskError(
            'tokens_required',
            'Enter both the bot token and app-level token.',
          )
        const projects = await this.deps.host.projects()
        if (
          params.routes.some((route) => !projects.some((project) => project.id === route.projectId))
        )
          throw new ExternalTaskError(
            'project_unavailable',
            'A mapped project is unavailable. Select a registered project.',
          )
        await this.#stopTransport()
        this.#status = 'connecting'
        this.#message = null
        await this.#publish()
        const transport = (this.deps.transport ?? createSlackTransport)(botToken, appToken)
        this.#transport = transport
        const identity = await transport.identity()
        if (this.#closed || generation !== this.#generation)
          throw new ExternalTaskError(
            'superseded',
            'The connection was cancelled before installation verification finished.',
          )
        if (identity.botUserId === params.ownerUserId)
          throw new ExternalTaskError(
            'invalid_owner',
            'Enter your human Slack member ID, rather than the bot’s ID.',
          )
        const previous = this.store.state.connection
        const connectorId =
          previous?.workspaceId === identity.workspaceId &&
          previous.botUserId === identity.botUserId &&
          previous.ownerUserId === params.ownerUserId
            ? previous.id
            : `slack_${randomUUID()}`
        await this.store.update((state) => {
          if (this.#closed || generation !== this.#generation)
            throw new ExternalTaskError('superseded', 'The connection was cancelled before saving.')
          state.revision++
          state.enabled = true
          state.connection = {
            id: connectorId,
            ...identity,
            ownerUserId: params.ownerUserId,
            permissionMode: params.permissionMode,
            routes: params.routes.map((route) => ({ ...route })),
          }
          state.secrets = { bot: box.encrypt(botToken), app: box.encrypt(appToken) }
          for (const entry of Object.values(state.outbox))
            if (entry.state === 'pending') entry.state = 'cancelled'
        })
        await this.#listen(transport, generation)
        return { ok: true, snapshot: await this.snapshot() }
      } catch (error) {
        await this.#stopTransport()
        if (generation === this.#generation && !this.#closed) {
          this.#status = 'error'
          this.#message = this.#publicError(error)
          await this.#publish()
        }
        return {
          ok: false,
          error: {
            code: error instanceof ExternalTaskError ? error.code : 'connection_failed',
            message: this.#publicError(error),
          },
        }
      }
    })
  }

  disconnect(): Promise<SlackMutationResult> {
    this.#generation++
    return this.#serialize(async () => {
      await this.ready
      try {
        await this.#stopTransport()
        if (!this.#recordError)
          await this.store.update((state) => {
            state.enabled = false
            state.revision++
            for (const entry of Object.values(state.outbox))
              if (entry.state === 'pending') entry.state = 'cancelled'
          })
        this.#status = this.#recordError ? 'error' : 'disconnected'
        if (!this.#recordError) this.#message = null
        return { ok: true, snapshot: await this.snapshot() }
      } catch {
        return {
          ok: false,
          error: {
            code: 'save_failed',
            message:
              'The socket was closed, but the disabled setting could not be saved. Review it before restarting Ari.',
          },
        }
      }
    })
  }

  forget(): Promise<SlackMutationResult> {
    this.#generation++
    return this.#serialize(async () => {
      await this.ready
      try {
        await this.#stopTransport()
        await this.store.reset()
        this.#recordError = false
        this.#status = 'disconnected'
        this.#message = null
        return { ok: true, snapshot: await this.snapshot() }
      } catch {
        return {
          ok: false,
          error: {
            code: 'save_failed',
            message: 'The socket was closed, but the connection records could not be cleared.',
          },
        }
      }
    })
  }

  async #connect(bot: string, app: string): Promise<void> {
    const generation = ++this.#generation
    await this.#stopTransport()
    this.#status = 'connecting'
    this.#message = null
    await this.#publish()
    try {
      const transport = (this.deps.transport ?? createSlackTransport)(bot, app)
      this.#transport = transport
      const identity = await transport.identity()
      if (this.#closed || generation !== this.#generation)
        throw new ExternalTaskError(
          'superseded',
          'The saved connection was cancelled during verification.',
        )
      const connection = this.store.state.connection
      if (
        !connection ||
        connection.workspaceId !== identity.workspaceId ||
        connection.botUserId !== identity.botUserId
      )
        throw new ExternalTaskError(
          'identity_changed',
          'The saved tokens identify another Slack installation. Configure the connection again.',
        )
      await this.#listen(transport, generation)
    } catch (error) {
      await this.#stopTransport()
      this.#status = 'error'
      this.#message = this.#publicError(error)
      await this.#publish()
    }
  }

  async #listen(transport: SlackTransport, generation: number): Promise<void> {
    if (this.#closed || generation !== this.#generation)
      throw new ExternalTaskError('superseded', 'A newer connection action replaced this request.')
    this.#off = this.deps.host.subscribe(() => this.#scheduleRefresh())
    await transport.start(
      (envelope) => this.receive(envelope, generation),
      (state) => {
        if (this.#closed || generation !== this.#generation || this.#transport !== transport) return
        this.#status = state
        this.#message =
          state === 'error'
            ? 'Slack could not confirm a connection or persist an incoming request. Check this connection before retrying.'
            : null
        void this.#publish()
        if (state === 'connected') {
          this.#resume()
          this.#scheduleRefresh()
          this.#schedulePump()
        }
      },
    )
    if (generation !== this.#generation || this.#closed) {
      await transport.close()
      return
    }
    this.#status = 'connected'
    this.#message = null
    this.#resume()
    this.#scheduleRefresh()
    this.#schedulePump()
    await this.#publish()
  }

  #credentials(): { bot: string; app: string } | null {
    const saved = this.store.state.secrets
    const box = this.deps.secrets()
    if (!saved || !box) return null
    const bot = box.decrypt(saved.bot),
      app = box.decrypt(saved.app)
    return bot && app ? { bot, app } : null
  }

  async receive(envelope: SlackEnvelope, generation = this.#generation): Promise<unknown> {
    await this.ready
    if (
      this.#closed ||
      this.#recordError ||
      generation !== this.#generation ||
      !this.store.state.enabled
    )
      return undefined
    if (this.#status === 'error')
      throw new Error('The Slack connection needs inspection before accepting more requests.')
    if (envelope.type === 'events_api') {
      const parsed = mentionSchema.safeParse(envelope.body)
      if (!parsed.success) return undefined
      const body = parsed.data,
        event = body.event,
        connection = this.store.state.connection
      if (
        !connection ||
        body.team_id !== connection.workspaceId ||
        event.user !== connection.ownerUserId ||
        event.subtype !== undefined ||
        event.bot_id !== undefined ||
        event.user === connection.botUserId ||
        (connection.appId !== null && body.api_app_id !== connection.appId) ||
        !connection.routes.some((route) => route.channelId === event.channel)
      )
        return undefined
      const mention = `<@${connection.botUserId}>`
      if (!event.text.includes(mention)) return undefined
      const source: ExternalSource = {
        platform: 'slack',
        connectorId: connection.id,
        requestId: digest([connection.id, body.team_id, body.event_id]),
        workspaceId: body.team_id,
        channelId: event.channel,
        threadId: event.thread_ts ?? event.ts,
        senderId: event.user,
      }
      const request = { source, text: event.text.split(mention).join('').trim() || 'help' }
      const previous = this.store.state.requests[source.requestId]
      let interaction:
        | {
            callbackId: string
            value: string | null
            triggerId: string | null
            callback?: SlackCallback
          }
        | undefined
      if (previous?.callbackId)
        interaction = { callbackId: previous.callbackId, value: previous.value, triggerId: null }
      const intent = externalIntent(request.text)
      if (!previous && intent.kind === 'answer') {
        const binding = this.store.state.bindings[externalThreadKey(source)]
        const view =
          binding && this.#bindingAllowed(binding) && binding.state === 'ready'
            ? await this.deps.host.view(binding.sessionId, binding.projectId)
            : null
        const inputs =
          view?.pending.filter((pending) => pending.kind === 'input' && pending.available) ?? []
        if (binding && inputs.length === 1) {
          const input = inputs[0]!
          const payload = parseQuestionPayload(input.prompt, input.choicesJson)
          let value: string | null = intent.text
          if (payload.kind === 'questionnaire') {
            const question = payload.questions[0]
            value =
              payload.questions.length === 1 && question
                ? encodeAnswers([question], { [question.id]: intent.text }, new Set([question.id]))
                : null
          }
          if (value !== null) {
            const callback = this.#callback(binding, input, null)
            interaction = { callbackId: callback.id, value, triggerId: null, callback }
          }
        }
      }
      await this.#accept(request, 'message', generation, interaction)
      return undefined
    }
    if (envelope.type !== 'interactive') return undefined
    const action = actionSchema.safeParse(envelope.body)
    if (action.success) {
      const body = action.data,
        choice = body.actions[0]!,
        callback = this.store.state.callbacks[choice.value]
      const binding = callback ? this.store.state.bindings[callback.bindingKey] : null
      if (
        !callback ||
        !binding ||
        !this.#callbackAllowed(callback, binding, body.team.id, body.user.id) ||
        binding.channelId !== body.channel.id ||
        binding.threadId !== (body.message.thread_ts ?? body.message.ts) ||
        !['ari_approval', 'ari_input'].includes(choice.action_id)
      )
        return undefined
      const source = this.#source(
        binding,
        digest([callback.id, body.user.id, choice.action_ts ?? envelope.envelopeId]),
      )
      const open = callback.kind === 'input' && callback.value === null
      await this.#accept(
        { source, text: open ? 'Open question' : 'Answer request' },
        open ? 'open-question' : 'callback',
        generation,
        {
          callbackId: callback.id,
          value: callback.value,
          triggerId: open ? body.trigger_id : null,
        },
      )
      return undefined
    }
    const submission = submissionSchema.safeParse(envelope.body)
    if (!submission.success) return undefined
    const body = submission.data,
      callback = this.store.state.callbacks[body.view.private_metadata]
    const binding = callback ? this.store.state.bindings[callback.bindingKey] : null
    if (
      !callback ||
      !binding ||
      callback.kind !== 'input' ||
      !this.#callbackAllowed(callback, binding, body.team.id, body.user.id)
    )
      return {
        response_action: 'errors',
        errors: { q0: 'This connection or request changed. Use the current Answer button.' },
      }
    try {
      const value = questionAnswer(callback, body.view.state.values)
      const source = this.#source(binding, digest([callback.id, body.view.id, body.user.id, value]))
      await this.#accept({ source, text: 'Answer request' }, 'callback', generation, {
        callbackId: callback.id,
        value,
        triggerId: null,
      })
      return undefined
    } catch (error) {
      if (error instanceof SlackFormError)
        return { response_action: 'errors', errors: error.errors }
      throw error
    }
  }

  async #accept(
    request: ExternalRequest,
    kind: SlackStoredRequest['kind'],
    generation: number,
    interaction?: {
      callbackId: string
      value: string | null
      triggerId: string | null
      callback?: SlackCallback
    },
  ): Promise<void> {
    const revision = this.store.state.revision
    const fingerprint = digest([
      request,
      kind,
      kind === 'message' ? null : interaction?.callbackId,
      interaction?.value ?? null,
    ])
    await this.store.update((state) => {
      this.#assert(request.source, revision, generation)
      const existing = state.requests[request.source.requestId]
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ExternalTaskError(
            'conflict',
            'Slack redelivered this request with different content.',
          )
        return
      }
      if (Object.keys(state.requests).length >= 1000)
        throw new ExternalTaskError(
          'capacity',
          'The Slack pilot request history is full. Review or forget this connection in Ari.',
        )
      if (interaction?.callback) state.callbacks[interaction.callback.id] = interaction.callback
      state.requests[request.source.requestId] = {
        request,
        fingerprint,
        revision,
        phase: 'received',
        sessionId: null,
        kind,
        callbackId: interaction?.callbackId ?? null,
        value: interaction?.value ?? null,
        triggerId: interaction?.triggerId ?? null,
        error: null,
        at: Date.now(),
      }
    })
    this.#schedule(request.source.requestId)
  }

  #schedule(id: string): void {
    const record = this.store.state.requests[id]
    if (
      !record ||
      this.#scheduled.has(id) ||
      ['completed', 'failed', 'uncertain'].includes(record.phase) ||
      this.#closed
    )
      return
    this.#scheduled.add(id)
    const key = externalThreadKey(record.request.source)
    const generation = this.#generation
    const run = async () => {
      try {
        await this.#process(id, generation)
      } catch (error) {
        await this.#fail(id, error).catch(() => undefined)
      } finally {
        this.#scheduled.delete(id)
        await this.#publish()
      }
    }
    const job =
      record.kind === 'open-question' ? run() : (this.#jobs.get(key) ?? Promise.resolve()).then(run)
    if (record.kind !== 'open-question') this.#jobs.set(key, job)
    this.#background.add(job)
    void job
      .finally(() => {
        this.#background.delete(job)
        if (this.#jobs.get(key) === job) this.#jobs.delete(key)
      })
      .catch(() => undefined)
  }

  #resume(): void {
    for (const request of Object.values(this.store.state.requests))
      this.#schedule(request.request.source.requestId)
  }

  async #process(id: string, generation: number): Promise<void> {
    let record = this.store.state.requests[id]
    if (!record) return
    const source = record.request.source,
      key = externalThreadKey(source)
    const guard = () => {
      this.#assert(source, record!.revision, generation)
      const binding = this.store.state.bindings[key]
      if (binding && !this.#bindingAllowed(binding))
        throw new ExternalTaskError(
          'revoked',
          'This thread’s project mapping changed. Start a new task in a mapped channel.',
        )
    }
    guard()
    const route = this.store.state.connection!.routes.find(
      (route) => route.channelId === source.channelId,
    )!
    let binding = this.store.state.bindings[key]
    let justReserved = false
    const intent = externalIntent(record.request.text)

    if (record.phase === 'submitting') {
      if (
        record.kind === 'message' &&
        record.sessionId &&
        intent.kind === 'prompt' &&
        (await this.deps.host.hasRequest(record.sessionId, id))
      ) {
        await this.#finish(
          id,
          'Ari accepted this request. Use status in this thread to inspect the task.',
        )
        return
      }
      await this.#uncertain(
        id,
        'Ari restarted while this operation was being submitted. Inspect the original task before assigning more work.',
      )
      return
    }
    if (record.kind === 'callback' || record.kind === 'open-question' || intent.kind === 'answer') {
      const callback = record.callbackId ? this.store.state.callbacks[record.callbackId] : null
      if (!binding || !callback || binding.state !== 'ready')
        throw new ExternalTaskError(
          'input_required',
          'Use the current Answer button for this question. It preserves the original request and turn.',
        )
      const live = await this.#liveRequest(binding, callback)
      guard()
      if (record.kind === 'open-question') {
        const modal = questionModal(callback)
        if (!modal)
          throw new ExternalTaskError(
            'unsupported_question',
            'Review this plan or large questionnaire in Ari. The task is waiting for your answer there.',
          )
        if (!record.triggerId || Date.now() - record.at > 2500)
          throw new ExternalTaskError(
            'trigger_expired',
            'The question button timed out. Click the current Answer button again.',
          )
        await this.#phase(id, 'submitting', binding.sessionId)
        guard()
        await this.#transport?.openModal(record.triggerId, modal)
        await this.#finish(id)
        return
      }
      const value = record.value ?? callback.value
      if (value === null)
        throw new ExternalTaskError('answer_required', 'Use the Answer button to enter a response.')
      await this.#phase(id, 'submitting', binding.sessionId)
      guard()
      await this.deps.host.answer(
        binding.sessionId,
        binding.projectId,
        live,
        value,
        this.store.state.connection!.permissionMode,
        guard,
      )
      await this.#finish(id, 'Your response was accepted by Ari.')
      this.#scheduleRefresh()
      return
    }

    if (intent.kind === 'help') {
      await this.#finish(id, slackHelp)
      return
    }
    if (intent.kind === 'status' || intent.kind === 'stop') {
      if (!binding || binding.state !== 'ready') {
        await this.#finish(
          id,
          'There is no running Ari task bound to this thread. Mention @Aria with a task in a mapped channel to start one.',
        )
        return
      }
      const view = await this.deps.host.view(binding.sessionId, binding.projectId)
      if (!view || view.connectorId !== source.connectorId)
        throw new ExternalTaskError('not_found', 'This thread’s task is unavailable in Ari.')
      guard()
      if (intent.kind === 'status') {
        const latest =
          !view.activeTurnId && !view.workingChildren && view.lastTurn?.text
            ? `\n\nLatest result:\n${view.lastTurn.text.slice(0, 6500)}`
            : ''
        await this.#finish(id, `${statusText(view)}${latest}`)
      } else {
        await this.#phase(id, 'submitting', binding.sessionId)
        await this.deps.host.stop(
          binding.sessionId,
          binding.projectId,
          this.store.state.connection!.permissionMode,
          guard,
        )
        await this.#finish(
          id,
          'Stop requested for the task’s current turn. Queued follow-ups remain held in Ari.',
        )
        this.#scheduleRefresh()
      }
      return
    }

    if (intent.kind !== 'prompt')
      throw new ExternalTaskError('unsupported', 'Use help to see the supported Slack controls.')
    const project = (await this.deps.host.projects()).find(
      (project) => project.id === route.projectId,
    )
    guard()
    if (
      intent.projectName &&
      intent.projectName.toLocaleLowerCase() !== project?.name.toLocaleLowerCase()
    )
      throw new ExternalTaskError(
        'project_scope',
        'That project is not mapped to this Slack channel. Review the channel mapping in Ari.',
      )
    if (!intent.text.trim())
      throw new ExternalTaskError('empty_task', 'Include a task after the project name.')
    if (!binding) {
      if (!project?.ready)
        throw new ExternalTaskError(
          'project_not_ready',
          project?.reason ?? 'The mapped project is unavailable. Review it in Ari.',
        )
      const sessionId = `sess_slack_${randomUUID().replace(/-/g, '')}`
      await this.store.update((state) => {
        guard()
        if (Object.keys(state.bindings).length >= 200)
          throw new ExternalTaskError(
            'capacity',
            'The Slack pilot task history is full. Review or forget this connection in Ari.',
          )
        state.bindings[key] = {
          key,
          sessionId,
          projectId: route.projectId,
          ownerId: source.senderId,
          connectorId: source.connectorId,
          workspaceId: source.workspaceId,
          channelId: source.channelId,
          threadId: source.threadId,
          creationRequestId: id,
          state: 'reserved',
          lastResultTurnId: null,
          lastStatus: null,
          progressMessageTs: null,
          notifications: [],
          cursor: -1,
        }
        state.requests[id]!.phase = 'creating'
        state.requests[id]!.sessionId = sessionId
        this.#appendReply(
          state,
          record!,
          'Preparing an isolated Ari session for this request.',
          'received',
        )
      })
      this.#schedulePump()
      justReserved = true
      binding = this.store.state.bindings[key]!
      record = this.store.state.requests[id]!
    } else if (binding.state === 'unavailable') {
      throw new ExternalTaskError(
        'unavailable',
        'The original creation could not be confirmed. Inspect it in Ari and use a new Slack thread for separate work.',
      )
    }

    let started = false
    if (binding.state === 'reserved') {
      if (binding.creationRequestId !== id)
        throw new ExternalTaskError(
          'unavailable',
          'The original task has not been created. Inspect its request before continuing.',
        )
      // A reserved identity left by a prior process is never used for another creation attempt.
      if (record.phase === 'creating' && !justReserved) {
        const existing = await this.deps.host.view(binding.sessionId, binding.projectId)
        if (!existing) {
          await this.#uncertain(
            id,
            'Ari restarted during session creation. Its reserved identity is retained; no second worktree or session was created.',
          )
          return
        }
      }
      const agent = await this.deps.host.create(
        {
          sessionId: binding.sessionId,
          projectId: binding.projectId,
          text: intent.text,
          source,
          permissionMode: this.store.state.connection!.permissionMode,
        },
        guard,
      )
      guard()
      await this.store.update((state) => {
        guard()
        state.bindings[key]!.state = 'ready'
        state.requests[id]!.phase = 'created'
        this.#appendReply(
          state,
          record,
          `Started in ${project?.name ?? 'the mapped project'} · ${agent.driverKind} / ${agent.modelId ?? 'default'} · ${agent.effort ?? 'provider default'} effort · ${agent.permissionMode} permissions.\nFind “${`Slack · ${intent.text.replace(/\s+/g, ' ').slice(0, 90)}`}” in Ari.`,
          'started',
        )
      })
      started = true
      this.#schedulePump()
    }
    await this.#phase(id, 'submitting', binding.sessionId)
    guard()
    const accepted = await this.deps.host.prompt(
      binding.sessionId,
      binding.projectId,
      intent.text,
      source,
      this.store.state.connection!.permissionMode,
      guard,
    )
    await this.#finish(
      id,
      started
        ? undefined
        : accepted.queued
          ? 'Follow-up queued in Ari. It will run after the current turn finishes.'
          : 'Follow-up accepted. Ari is running the next turn.',
    )
    this.#scheduleRefresh()
  }

  async #phase(id: string, phase: SlackStoredRequest['phase'], sessionId: string): Promise<void> {
    await this.store.update((state) => {
      const record = state.requests[id]
      if (record) {
        record.phase = phase
        record.sessionId = sessionId
      }
    })
  }

  async #finish(id: string, text?: string): Promise<void> {
    await this.store.update((state) => {
      const record = state.requests[id]
      if (!record) return
      record.phase = 'completed'
      record.error = null
      if (text) this.#appendReply(state, record, text, 'receipt')
    })
    this.#schedulePump()
  }

  async #fail(id: string, error: unknown): Promise<void> {
    if (!(error instanceof ExternalTaskError)) {
      await this.#uncertain(id, this.#publicError(error))
      return
    }
    await this.store.update((state) => {
      const record = state.requests[id]
      if (!record) return
      record.phase = 'failed'
      record.error = error.message
      const binding = state.bindings[externalThreadKey(record.request.source)]
      if (binding?.state === 'reserved') binding.state = 'unavailable'
      this.#appendReply(state, record, error.message, 'error')
    })
    this.#schedulePump()
  }

  async #uncertain(id: string, message: string): Promise<void> {
    await this.store.update((state) => {
      const record = state.requests[id]
      if (!record) return
      record.phase = 'uncertain'
      record.error = message
      const binding = state.bindings[externalThreadKey(record.request.source)]
      if (binding?.state === 'reserved') binding.state = 'unavailable'
      this.#appendReply(state, record, message, 'uncertain')
    })
    this.#schedulePump()
  }

  #appendReply(state: SlackState, record: SlackStoredRequest, text: string, suffix: string): void {
    const source = record.request.source,
      id = digest([source.requestId, suffix])
    if (state.outbox[id]) return
    const bindingKey = externalThreadKey(source)
    const projectId =
      state.bindings[bindingKey]?.projectId ??
      state.connection?.routes.find((route) => route.channelId === source.channelId)?.projectId
    if (!projectId) return
    state.outbox[id] = {
      id,
      bindingKey: state.bindings[bindingKey] ? bindingKey : null,
      projectId,
      connectorId: source.connectorId,
      ownerId: source.senderId,
      revision: record.revision,
      channelId: source.channelId,
      threadId: source.threadId,
      reply: { text: text.slice(0, 11_000) },
      purpose: 'message',
      turnId: null,
      state: 'pending',
      messageTs: null,
      retryAt: 0,
      at: Date.now(),
    }
  }

  #callback(
    binding: SlackBinding,
    pending: ExternalPendingRequest,
    value: string | null,
  ): SlackCallback {
    return {
      id: randomUUID(),
      bindingKey: binding.key,
      revision: this.store.state.revision,
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      requestId: pending.id,
      kind: pending.kind,
      value,
      prompt: pending.prompt.slice(0, 16_000),
      choicesJson: pending.choicesJson,
      at: Date.now(),
    }
  }

  async #liveRequest(
    binding: SlackBinding,
    callback: SlackCallback,
  ): Promise<ExternalPendingRequest> {
    if (!this.#callbackAllowed(callback, binding, binding.workspaceId, binding.ownerId))
      throw new ExternalTaskError('revoked', 'This request’s connection or project grant changed.')
    const view = await this.deps.host.view(binding.sessionId, binding.projectId)
    const live = view?.pending.find(
      (request) =>
        request.sessionId === callback.sessionId &&
        request.turnId === callback.turnId &&
        request.kind === callback.kind &&
        request.id === callback.requestId,
    )
    if (
      !view ||
      view.connectorId !== binding.connectorId ||
      !live ||
      !live.available ||
      live.prompt.slice(0, 16_000) !== callback.prompt ||
      live.choicesJson !== callback.choicesJson ||
      (callback.kind === 'approval' &&
        !live.options.some((option) => option.optionId === callback.value))
    )
      throw new ExternalTaskError(
        'stale',
        'This request changed, was answered, or its callback is unavailable. Use the current request or review it in Ari.',
      )
    return live
  }

  #scheduleRefresh(): void {
    if (this.#closed || !this.store.state.enabled || this.#refreshTimer) return
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined
      void this.#refresh().catch(() => {
        this.#message =
          'Ari could not record a Slack status update. Inspect the connection before retrying.'
        void this.#publish()
      })
    }, 150)
    this.#refreshTimer.unref()
  }

  #refresh(): Promise<void> {
    if (this.#refreshing) {
      const current = this.#refreshing
      // The in-flight pass already read the session. One later pass applies this request.
      this.#refreshFollowUp ??= current.finally(() => {
        this.#refreshFollowUp = null
        if (this.#refreshing === current) this.#refreshing = null
        if (this.#closed) return
        return this.#refresh()
      })
      return this.#refreshFollowUp
    }
    const generation = this.#generation,
      revision = this.store.state.revision
    const operation = (async () => {
      for (const binding of Object.values(this.store.state.bindings)) {
        if (this.#closed || generation !== this.#generation) return
        if (binding.state !== 'ready' || !this.#bindingAllowed(binding)) continue
        const view = await this.deps.host.view(binding.sessionId, binding.projectId)
        if (!view || view.connectorId !== binding.connectorId || generation !== this.#generation)
          continue
        const status = statusText(view)
        const settled =
          !view.activeTurnId &&
          !view.workingChildren &&
          view.lastTurn !== null &&
          (view.queued === 0 || view.lastTurn.outcome !== 'completed')
        await this.store.update((state) => {
          if (
            generation !== this.#generation ||
            revision !== state.revision ||
            !this.#bindingAllowed(binding)
          )
            return
          const current = state.bindings[binding.key]
          if (!current) return
          current.cursor = Math.max(current.cursor, view.seq)
          if (
            current.lastStatus !== status &&
            (view.activeTurnId ||
              view.workingChildren ||
              view.pending.length ||
              settled ||
              view.archived)
          ) {
            current.lastStatus = status
            const progressId = digest([binding.key, revision, 'progress', view.seq, status])
            this.#frame(state, binding, progressId, { text: status }, 'progress', view.activeTurnId)
          }
          for (const pending of view.pending) {
            const noticeId = digest([
              binding.key,
              revision,
              pending.sessionId,
              pending.turnId,
              pending.id,
              pending.available,
            ])
            if (current.notifications.includes(noticeId)) continue
            const blocks: NonNullable<SlackReply['blocks']> = [
              {
                type: 'section',
                text: slackPlain(
                  `${pending.kind === 'approval' ? 'Approval needed' : 'Your answer is needed'} · ${view.title}\n\n${pending.prompt}`,
                ),
              },
            ]
            if (!pending.available)
              blocks.push({
                type: 'section',
                text: slackPlain(
                  'The provider callback is unavailable. Resume or review this request in Ari.',
                ),
              })
            else if (pending.kind === 'approval') {
              const callbacks = pending.options
                .slice(0, 25)
                .map((option) => this.#callback(binding, pending, option.optionId))
              for (const callback of callbacks) state.callbacks[callback.id] = callback
              for (let offset = 0; offset < callbacks.length; offset += 5)
                blocks.push({
                  type: 'actions',
                  elements: callbacks.slice(offset, offset + 5).map((callback, index) => ({
                    type: 'button',
                    action_id: 'ari_approval',
                    value: callback.id,
                    text: slackPlain(pending.options[offset + index]!.name.slice(0, 75)),
                  })),
                })
              if (pending.options.length === 0 || pending.options.length > 25)
                blocks.push({
                  type: 'section',
                  text: slackPlain('Review the complete provider choices in Ari.'),
                })
            } else {
              const callback = this.#callback(binding, pending, null)
              if (questionModal(callback)) {
                state.callbacks[callback.id] = callback
                blocks.push({
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      action_id: 'ari_input',
                      value: callback.id,
                      text: slackPlain('Answer'),
                    },
                  ],
                })
              } else
                blocks.push({
                  type: 'section',
                  text: slackPlain(
                    'Review this plan or large questionnaire in Ari. The task is waiting for your answer there.',
                  ),
                })
            }
            this.#frame(
              state,
              binding,
              noticeId,
              {
                text: `${view.title} is waiting for your ${pending.kind === 'approval' ? 'approval' : 'answer'}.`,
                blocks,
              },
              'message',
              pending.turnId,
            )
            current.notifications = [...current.notifications, noticeId].slice(-200)
          }
          if (settled && view.lastTurn && current.lastResultTurnId !== view.lastTurn.id) {
            const resultId = digest([binding.key, 'result', view.lastTurn.id])
            const previous = state.outbox[resultId]
            if (previous?.state === 'cancelled') {
              previous.state = 'pending'
              previous.revision = revision
              previous.retryAt = 0
            } else if (!previous)
              this.#frame(state, binding, resultId, resultReply(view), 'result', view.lastTurn.id)
          }
        })
      }
      this.#schedulePump()
    })()
    this.#refreshing = operation
    void operation
      .finally(() => {
        if (this.#refreshing === operation) this.#refreshing = null
      })
      .catch(() => undefined)
    return operation
  }

  #frame(
    state: SlackState,
    binding: SlackBinding,
    id: string,
    reply: SlackReply,
    purpose: SlackOutbound['purpose'],
    turnId: string | null,
  ): void {
    if (state.outbox[id]) return
    state.outbox[id] = {
      id,
      bindingKey: binding.key,
      projectId: binding.projectId,
      connectorId: binding.connectorId,
      ownerId: binding.ownerId,
      revision: state.revision,
      channelId: binding.channelId,
      threadId: binding.threadId,
      reply,
      purpose,
      turnId,
      state: 'pending',
      messageTs: null,
      retryAt: 0,
      at: Date.now(),
    }
  }

  #outboundAllowed(entry: SlackOutbound): boolean {
    const state = this.store.state,
      connection = state.connection
    return (
      !this.#closed &&
      state.enabled &&
      entry.revision === state.revision &&
      connection !== null &&
      entry.connectorId === connection.id &&
      entry.ownerId === connection.ownerUserId &&
      connection.routes.some(
        (route) => route.channelId === entry.channelId && route.projectId === entry.projectId,
      ) &&
      (entry.bindingKey === null ||
        (!!state.bindings[entry.bindingKey] &&
          this.#bindingAllowed(state.bindings[entry.bindingKey]!)))
    )
  }

  #schedulePump(): void {
    if (
      this.#closed ||
      this.#pumping ||
      this.#pumpTimer ||
      this.#status !== 'connected' ||
      !this.#transport
    )
      return
    const pending = Object.values(this.store.state.outbox).filter(
      (entry) => entry.state === 'pending',
    )
    if (!pending.length) return
    const earliest = Math.min(...pending.map((entry) => entry.retryAt))
    const delay = Math.max(0, Math.max(earliest, this.#nextPostAt) - Date.now())
    this.#pumpTimer = setTimeout(() => {
      this.#pumpTimer = undefined
      void this.#pump().catch(() => {
        this.#message =
          'A Slack delivery receipt could not be saved. Inspect the thread before resending.'
        void this.#publish()
      })
    }, delay)
    this.#pumpTimer.unref()
  }

  #pumpPromise: Promise<void> | null = null

  #pump(): Promise<void> {
    if (this.#pumpPromise) return this.#pumpPromise
    const operation = this.#deliver()
    this.#pumpPromise = operation
    void operation
      .finally(() => {
        if (this.#pumpPromise === operation) this.#pumpPromise = null
        this.#pumping = false
        this.#schedulePump()
      })
      .catch(() => undefined)
    return operation
  }

  async #deliver(): Promise<void> {
    const transport = this.#transport,
      generation = this.#generation
    if (!transport || this.#status !== 'connected' || this.#closed) return
    this.#pumping = true
    const entry = Object.values(this.store.state.outbox)
      .filter((entry) => entry.state === 'pending' && entry.retryAt <= Date.now())
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))[0]
    if (!entry) return
    const binding = entry.bindingKey ? this.store.state.bindings[entry.bindingKey] : null
    const unknownProgress =
      entry.purpose === 'progress' &&
      !binding?.progressMessageTs &&
      Object.values(this.store.state.outbox).some(
        (previous) =>
          previous.bindingKey === entry.bindingKey &&
          previous.purpose === 'progress' &&
          previous.state === 'uncertain',
      )
    if (!this.#outboundAllowed(entry) || unknownProgress) {
      await this.store.update((state) => {
        if (state.outbox[entry.id]?.state === 'pending') state.outbox[entry.id]!.state = 'cancelled'
      })
      return
    }
    await this.store.update((state) => {
      state.outbox[entry.id]!.state = 'sending'
    })
    if (generation !== this.#generation || !this.#outboundAllowed(entry)) {
      await this.store.update((state) => {
        state.outbox[entry.id]!.state = 'cancelled'
      })
      return
    }
    try {
      const timestamp =
        entry.purpose === 'progress' && binding?.progressMessageTs
          ? await transport.update(entry.channelId, binding.progressMessageTs, entry.reply)
          : await transport.post(entry.channelId, entry.threadId, entry.reply)
      await this.store.update((state) => {
        const saved = state.outbox[entry.id]
        if (!saved) return
        saved.state = 'sent'
        saved.messageTs = timestamp
        const current = saved.bindingKey ? state.bindings[saved.bindingKey] : null
        if (current && saved.purpose === 'progress') current.progressMessageTs = timestamp
        if (current && saved.purpose === 'result') current.lastResultTurnId = saved.turnId
      })
    } catch (error) {
      await this.store.update((state) => {
        const saved = state.outbox[entry.id]
        if (!saved) return
        if (error instanceof SlackTransportError && error.kind === 'rate_limit') {
          saved.state = 'pending'
          saved.retryAt = Date.now() + Math.max(1000, Math.min(86_400_000, error.retryAfter * 1000))
        } else
          saved.state =
            error instanceof SlackTransportError && error.kind === 'rejected'
              ? 'failed'
              : 'uncertain'
      })
      this.#message = this.#publicError(error)
    } finally {
      this.#nextPostAt = Date.now() + (this.deps.postIntervalMs ?? 1000)
      await this.#publish()
    }
  }

  /** Drain accepted work and current projections; provider execution remains independent. */
  async flush(): Promise<void> {
    await this.ready
    await Promise.allSettled([...this.#background])
    await this.#refresh()
    if (this.#pumpTimer) {
      clearTimeout(this.#pumpTimer)
      this.#pumpTimer = undefined
    }
    while (
      this.#status === 'connected' &&
      Object.values(this.store.state.outbox).some(
        (entry) => entry.state === 'pending' && entry.retryAt <= Date.now(),
      )
    ) {
      if (this.#nextPostAt > Date.now()) {
        this.#schedulePump()
        break
      }
      await this.#pump()
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#generation++
    await this.#serialize(() => this.#stopTransport())
    await Promise.allSettled([...this.#background])
    await this.#refreshing?.catch(() => undefined)
    await this.#pumpPromise?.catch(() => undefined)
  }

  #source(binding: SlackBinding, requestId: string): ExternalSource {
    return {
      platform: 'slack',
      connectorId: binding.connectorId,
      requestId,
      workspaceId: binding.workspaceId,
      channelId: binding.channelId,
      threadId: binding.threadId,
      senderId: binding.ownerId,
    }
  }

  #assert(source: ExternalSource, revision: number, generation: number): void {
    const state = this.store.state,
      connection = state.connection
    if (
      this.#closed ||
      this.#recordError ||
      generation !== this.#generation ||
      revision !== state.revision ||
      !state.enabled ||
      !connection ||
      source.connectorId !== connection.id ||
      source.workspaceId !== connection.workspaceId ||
      source.senderId !== connection.ownerUserId ||
      !connection.routes.some((route) => route.channelId === source.channelId)
    )
      throw new ExternalTaskError(
        'revoked',
        'This Slack connection or channel grant changed before the request ran.',
      )
  }

  #bindingAllowed(binding: SlackBinding): boolean {
    return this.store.state.enabled && this.#bindingScoped(binding)
  }

  #bindingScoped(binding: SlackBinding): boolean {
    const state = this.store.state,
      connection = state.connection
    return (
      connection !== null &&
      binding.connectorId === connection.id &&
      binding.ownerId === connection.ownerUserId &&
      binding.workspaceId === connection.workspaceId &&
      connection.routes.some(
        (route) => route.channelId === binding.channelId && route.projectId === binding.projectId,
      )
    )
  }

  #callbackAllowed(
    callback: SlackCallback,
    binding: SlackBinding,
    workspace: string,
    user: string,
  ): boolean {
    return (
      callback.revision === this.store.state.revision &&
      this.#bindingAllowed(binding) &&
      binding.state === 'ready' &&
      binding.workspaceId === workspace &&
      binding.ownerId === user
    )
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycle.catch(() => undefined).then(operation)
    this.#lifecycle = result
    return result
  }

  #publicError(error: unknown): string {
    return error instanceof ExternalTaskError || error instanceof SlackTransportError
      ? error.message
      : 'Ari could not save or complete this Slack operation. Inspect the task and connection before sending another request.'
  }

  async #publish(): Promise<void> {
    try {
      this.deps.onChanged?.(await this.snapshot())
    } catch {
      /* A UI observer never controls request execution. */
    }
  }

  async #stopTransport(): Promise<void> {
    this.#off?.()
    this.#off = null
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    if (this.#pumpTimer) clearTimeout(this.#pumpTimer)
    this.#refreshTimer = undefined
    this.#pumpTimer = undefined
    const transport = this.#transport
    this.#transport = null
    await transport?.close().catch(() => undefined)
  }
}

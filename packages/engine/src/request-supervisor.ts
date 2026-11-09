import { createHash } from 'node:crypto'
import type { CoordinationMessage } from '@ari/contracts/coordination'
import type { OperationReceipt } from '@ari/contracts/orchestration'
import { isHelmSession } from '@ari/contracts/helm'
import { createLogger } from '@ari/shared/logger'
import type { SupervisorHost } from './delegation-supervisor'
import {
  helmAttentionRecipient,
  helmReportRecipient,
  questionOwnerSessionId,
  turnRequester,
} from './helm'
import { questionNotice } from './delegation-state'
import { SupervisorStore } from './supervisor-store'

const log = createLogger('engine:requests')
type Request = NonNullable<CoordinationMessage['request']>
export interface RequestHost extends SupervisorHost {
  requestDelayMs?: number
  notifyRequest?(
    senderId: string,
    recipientId: string,
    text: string,
    request: Request,
    key: string,
  ): Promise<CoordinationMessage>
}

/** Durable, bounded attention delivery. Request notices never grant approval authority. */
export class RequestSupervisor {
  readonly #chains = new Map<string, Promise<void>>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #recipients = new Map<string, Set<string>>()
  #unsubscribe: (() => void) | null = null
  #closed = false
  #recovery: Promise<void> | null = null
  readonly #reads: SupervisorStore
  constructor(readonly host: RequestHost) {
    this.#reads = new SupervisorStore(() => host.store)
  }

  start(): void {
    if (this.#unsubscribe) return
    this.#closed = false
    this.#reads.start()
    // Subscribe first; each read reconciles the journal, including events during recovery.
    this.#unsubscribe = this.host.subscribe((event) => {
      if (event.type === 'coordination.updated' && event.message.request)
        this.#remember(event.message)
      if (
        [
          'input.requested',
          'input.responded',
          'approval.requested',
          'approval.responded',
          'turn.settled',
        ].includes(event.type)
      )
        void this.#serial(`source:${event.sessionId}`, () => this.#synchronize(event.sessionId))
      if (event.type === 'coordination.updated' || event.type === 'turn.settled')
        this.#schedule(event.sessionId)
    })
    this.#recovery = this.#recover().catch((error: unknown) =>
      log.warn('request recovery failed', { error: String(error) }),
    )
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#reads.close()
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    await this.#recovery
    await Promise.all([...this.#chains.values()])
  }

  #serial(key: string, run: () => Promise<void>): Promise<void> {
    const next = (this.#chains.get(key) ?? Promise.resolve())
      .then(() => {
        if (!this.#closed) return run()
        return undefined
      })
      .catch((error: unknown) => {
        log.warn('request synchronization failed', { key, error: String(error) })
        if (this.#unsubscribe) this.#schedule(key.replace(/^recipient:/, ''), 15_000)
      })
    this.#chains.set(key, next)
    void next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key)
    })
    return next
  }

  #schedule(id: string, delay = this.host.requestDelayMs ?? 50): void {
    if (!this.#unsubscribe || this.#timers.has(id)) return
    const timer = setTimeout(() => {
      this.#timers.delete(id)
      if (id.startsWith('source:')) void this.#serial(id, () => this.#synchronize(id.slice(7)))
      else void this.evaluate(id)
    }, delay)
    timer.unref?.()
    this.#timers.set(id, timer)
  }

  async #recover(): Promise<void> {
    const rows = await this.#reads.store.listSessions()
    for (const row of rows)
      for (const message of Object.values(
        (await this.#reads.store.loadExisting(row.id))?.inbox ?? {},
      )) {
        this.#remember(message)
        if (message.status === 'delivering' && this.host.isRunning?.(row.id) === false)
          await this.host.record(row.id, {
            type: 'coordination.updated',
            message: { ...message, status: 'uncertain' },
          })
      }
    for (const row of rows) await this.#serial(`source:${row.id}`, () => this.#synchronize(row.id))
    for (const row of rows) this.#schedule(row.id)
  }

  #remember(message: CoordinationMessage): void {
    if (!message.request || message.request.resolvedAt !== null) return
    const recipients = this.#recipients.get(message.senderSessionId) ?? new Set<string>()
    recipients.add(message.recipientSessionId)
    this.#recipients.set(message.senderSessionId, recipients)
  }

  async #synchronize(id: string): Promise<void> {
    const source = await this.#reads.store.loadExisting(id)
    if (!source?.session) return
    if (
      !source.pendingInputs.length &&
      !source.pendingApprovals.length &&
      !this.#recipients.has(id)
    )
      return
    const owner = await questionOwnerSessionId(this.#reads.store, source)
    const aria = await helmAttentionRecipient(this.#reads.store, source)
    const recipients = new Set([...(owner ? [owner] : []), ...(aria ? [aria] : [])])
    if (source.activeTurnId && !source.session.archived && this.host.isRunning?.(id) !== false) {
      for (const input of source.pendingInputs) {
        const request: Request = {
          kind: 'input',
          requestId: input.inputId,
          sourceTurnId: source.activeTurnId,
          ownerSessionId: owner,
          resolvedAt: null,
        }
        for (const recipient of recipients) {
          const text =
            owner === recipient
              ? questionNotice({ childSessionId: id, title: source.session.title, ...input })
              : `[Ari work needs attention: ${source.session.title} (${id}) is waiting on a question owned by ${owner ?? 'the human'}.]\n\n${input.prompt}\n\nRead current context with ari session read ${id} --turns 1 --json. ${owner ? `Coordinate authorized guidance with ari session message ${owner}; only that requester can answer this question.` : 'Surface the question to the user; do not answer on their behalf.'}`
          await this.#notify(id, recipient, text, request)
        }
      }
      // Approval cards remain in their original session and are answered only by a human.
      for (const approval of source.pendingApprovals) {
        for (const recipient of recipients)
          await this.#notify(
            id,
            recipient,
            `[Ari work needs human approval: ${source.session.title} (${id}).]\n\n${approval.toolName}: ${approval.summaryJson.slice(0, 2_000)}\nApproval id: ${approval.approvalId}\n\nTell the user which session needs approval and direct them to its approval card. Do not answer it or substitute a session prompt/message for approval. Read current context with ari session read ${id} --turns 1 --json.`,
            {
              kind: 'approval',
              requestId: approval.approvalId,
              sourceTurnId: source.activeTurnId,
              ownerSessionId: null,
              resolvedAt: null,
            },
          )
      }
    }
    // Resolve stale notices from the authoritative source, without pretending anyone consumed them.
    for (const recipient of this.#recipients.get(id) ?? []) {
      const model = await this.#reads.store.loadExisting(recipient)
      for (const message of Object.values(model?.inbox ?? {})) {
        if (
          message.senderSessionId !== id ||
          !message.request ||
          message.request.resolvedAt !== null
        )
          continue
        const request = message.request
        const pending =
          source.activeTurnId === request.sourceTurnId &&
          (request.kind === 'input'
            ? source.pendingInputs.some((input) => input.inputId === request.requestId)
            : source.pendingApprovals.some((approval) => approval.approvalId === request.requestId))
        if (!pending)
          await this.host.record(recipient, {
            type: 'coordination.updated',
            message: { ...message, request: { ...request, resolvedAt: Date.now() } },
          })
      }
    }
    if (!source.pendingInputs.length && !source.pendingApprovals.length) this.#recipients.delete(id)
  }

  async #notify(
    senderId: string,
    recipientId: string,
    text: string,
    request: Request,
  ): Promise<void> {
    const recipient = await this.#reads.store.loadExisting(recipientId)
    if (!recipient?.session || recipient.session.archived) return
    const key = `request_${createHash('sha256')
      .update(
        JSON.stringify([
          senderId,
          recipientId,
          request.kind,
          request.sourceTurnId,
          request.requestId,
        ]),
      )
      .digest('hex')
      .slice(0, 32)}`
    const recipients = this.#recipients.get(senderId) ?? new Set<string>()
    recipients.add(recipientId)
    this.#recipients.set(senderId, recipients)
    if (this.host.notifyRequest)
      await this.host.notifyRequest(senderId, recipientId, text, request, key)
    else if (!recipient.inbox?.[key])
      await this.host.record(recipientId, {
        type: 'coordination.updated',
        message: {
          messageId: key,
          senderSessionId: senderId,
          recipientSessionId: recipientId,
          text,
          createdAt: Date.now(),
          status: 'pending',
          turnId: null,
          consumedAt: null,
          request,
        },
      })
    this.#schedule(recipientId)
  }

  evaluate(id: string): Promise<void> {
    return this.#serial(`recipient:${id}`, async () => {
      await this.#reconcile(id)
      if (!this.host.policy().enabled || !this.host.policy().autoDeliverResults) return
      const parent = await this.#reads.store.loadExisting(id)
      if (
        !parent?.session ||
        parent.session.archived ||
        parent.activeTurnId ||
        parent.queuedMessages.length ||
        parent.lastTurn?.stopReason !== 'completed'
      )
        return
      if (isHelmSession(parent.session)) {
        let automatic = 0
        for (const message of [...parent.messages].reverse()) {
          if (message.role !== 'user') continue
          if (!message.origin || message.origin.kind === 'human') break
          if (['completion', 'coordination'].includes(message.origin.kind)) automatic++
        }
        if (automatic >= 8) return
      }
      const messages: CoordinationMessage[] = []
      for (const message of Object.values(parent.inbox ?? {})) {
        if (messages.length === 32) break
        if (
          message.status !== 'pending' ||
          (message.request && message.request.resolvedAt !== null)
        )
          continue
        if (!(await this.#eligible(message, id))) continue
        // A cooperative wait reads the inbox itself, so never add a second provider turn.
        if (this.host.isWaiting?.(id, message.senderSessionId)) continue
        const uncertain = Object.values(parent.orchestration?.operations ?? {}).some(
          (operation) =>
            operation.method === 'request.notice.delivery' &&
            operation.status === 'uncertain' &&
            (operation.result as { messageIds?: string[] })?.messageIds?.includes(
              message.messageId,
            ),
        )
        if (!uncertain) messages.push(message)
      }
      if (!messages.length) return
      const messageIds = messages.map((message) => message.messageId)
      const operationId = `attention_${createHash('sha256').update(JSON.stringify(messageIds)).digest('hex').slice(0, 32)}`
      const operation: OperationReceipt = {
        operationId,
        method: 'request.notice.delivery',
        fingerprint: JSON.stringify(messageIds),
        status: 'started',
        startedAt: Date.now(),
        completedAt: null,
        detail: null,
        result: { messageIds },
      }
      await this.host.record(id, { type: 'orchestration.operation.updated', operation })
      const current = await this.#reads.store.loadExisting(id)
      let stillPending = true
      for (const message of messages) {
        if (!(await this.#eligible(message, id))) stillPending = false
      }
      if (
        this.#closed ||
        !stillPending ||
        !current ||
        current.activeTurnId ||
        current.session?.archived ||
        current.queuedMessages.length ||
        current.lastTurn?.turnId !== parent.lastTurn.turnId
      ) {
        await this.host.record(id, {
          type: 'orchestration.operation.updated',
          operation: {
            ...operation,
            status: 'completed',
            completedAt: Date.now(),
            result: { messageIds, accepted: false },
          },
        })
        return
      }
      const outcome = await this.host.dispatch(
        {
          type: 'turn.start',
          sessionId: id,
          text: `[Ari coordination update: current requests from work you coordinate. These are notices, not new assignments. Approvals remain human decisions; inbox delivery is not consumption.]\n\n${messages.map((message) => `[Inbox ${message.messageId}]\n${message.text}`).join('\n\n')}\n\nAcknowledge each exact inbox id only after acting on it with ari session ack.`,
          attachments: [],
        },
        { kind: 'coordination', deliveryId: operationId, messageIds },
      )
      if (outcome.accepted) await this.#reconcile(id)
      else {
        await this.host.record(id, {
          type: 'orchestration.operation.updated',
          operation: {
            ...operation,
            status: 'completed',
            completedAt: Date.now(),
            result: { messageIds, accepted: false },
          },
        })
        this.#schedule(id, 15_000)
      }
    })
  }

  async #eligible(message: CoordinationMessage, recipientId: string): Promise<boolean> {
    const source = await this.#reads.store.loadExisting(message.senderSessionId)
    if (!source?.session || source.session.archived) return false
    if (message.request) {
      if (source.activeTurnId !== message.request.sourceTurnId) return false
      return message.request.kind === 'input'
        ? source.pendingInputs.some((input) => input.inputId === message.request!.requestId)
        : source.pendingApprovals.some(
            (approval) => approval.approvalId === message.request!.requestId,
          )
    }
    // Explicit parent-directed coordination must reach an idle coordinator too.
    // Downstream and sibling notes still wait for live steering or the next assignment.
    const turnId = source.activeTurnId ?? source.lastTurn?.turnId
    if (!turnId) return false
    return (
      (source.session.parentSessionId === recipientId &&
        turnRequester(source, turnId) === recipientId) ||
      (await helmReportRecipient(this.#reads.store, source, turnId)) === recipientId
    )
  }

  async #reconcile(id: string): Promise<void> {
    const parent = await this.#reads.store.loadExisting(id)
    if (!parent) return
    for (const operation of Object.values(parent.orchestration?.operations ?? {})) {
      if (operation.method !== 'request.notice.delivery' || operation.status !== 'started') continue
      const accepted = parent.messages.find(
        (message) =>
          message.origin?.kind === 'coordination' &&
          message.origin.deliveryId === operation.operationId,
      )
      const messageIds = (operation.result as { messageIds?: string[] })?.messageIds ?? []
      if (accepted)
        for (const messageId of messageIds) {
          const message = (await this.#reads.store.load(id)).inbox?.[messageId]
          if (message?.status === 'pending')
            await this.host.record(id, {
              type: 'coordination.updated',
              message: { ...message, status: 'delivering', turnId: accepted.turnId },
            })
        }
      if (!accepted)
        for (const messageId of messageIds) {
          const message = (await this.#reads.store.load(id)).inbox?.[messageId]
          if (message?.status === 'pending')
            await this.host.record(id, {
              type: 'coordination.updated',
              message: { ...message, status: 'uncertain' },
            })
        }
      await this.host.record(id, {
        type: 'orchestration.operation.updated',
        operation: {
          ...operation,
          status: accepted ? 'completed' : 'uncertain',
          completedAt: accepted ? Date.now() : null,
          detail: accepted
            ? null
            : 'Request notice acceptance is uncertain; inspect the transcript before retrying. No automatic resend.',
          result: { messageIds, accepted: Boolean(accepted) },
        },
      })
    }
  }
}

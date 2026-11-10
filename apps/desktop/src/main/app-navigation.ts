import {
  appOpenReceiptSchema,
  appOpenTargetSchema,
  type AppOpenFrame,
  type AppOpenReceipt,
  type AppOpenTarget,
} from '@ari/contracts/rpc'
import { ControlFailure } from '@ari/contracts/agent-control'
import type { RpcRegistry } from './rpc-registry'

export const APP_NAVIGATION_TIMEOUT_MS = 5_000
interface Pending {
  frame: AppOpenFrame
  callerId: string
  resolve: (receipt: AppOpenReceipt) => void
  timer: ReturnType<typeof setTimeout>
  final?: AppOpenReceipt
  removeAbort?: () => void
}

/** One local Shell consumer. Publishing is a request, never evidence it applied. */
export class AppNavigation {
  #consumer: string | null = null
  #pending: Pending | null = null
  constructor(
    readonly deps: {
      registry: RpcRegistry
      validate: (callerId: string, target: AppOpenTarget) => Promise<void>
    },
  ) {}

  consumer(consumerId: string, connected: boolean): { registered: boolean } {
    if (!connected && this.#consumer !== consumerId) return { registered: false }
    if (this.#consumer !== consumerId || !connected) this.reset('consumer_replaced')
    this.#consumer = connected ? consumerId : null
    return { registered: connected }
  }

  reset(reason: 'disconnected' | 'consumer_replaced' = 'disconnected'): void {
    if (this.#pending) {
      const pending = this.#pending
      this.deps.registry.publish(
        'app.navigate',
        {
          kind: 'app.open.cancel',
          requestId: pending.frame.requestId,
          consumerId: pending.frame.consumerId,
        },
        (params) => params['navigationConsumerId'] === pending.frame.consumerId,
      )
      this.#finish(pending, {
        requestId: pending.frame.requestId,
        target: pending.frame.target,
        status: 'unconfirmed',
        reason,
      })
    }
    this.#consumer = null
  }

  open(
    callerId: string,
    raw: AppOpenTarget,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AppOpenReceipt> {
    const target = appOpenTargetSchema.parse(raw)
    if (signal?.aborted)
      return Promise.resolve({ requestId, target, status: 'unavailable', reason: 'disconnected' })
    if (!this.#consumer || this.deps.registry.subscriberCount('app.navigate') === 0)
      return Promise.resolve({ requestId, target, status: 'unavailable', reason: 'no_consumer' })
    if (this.#pending) {
      const old = this.#pending
      this.deps.registry.publish(
        'app.navigate',
        {
          kind: 'app.open.cancel',
          requestId: old.frame.requestId,
          consumerId: old.frame.consumerId,
        },
        (params) => params['navigationConsumerId'] === old.frame.consumerId,
      )
      this.#finish(old, {
        requestId: old.frame.requestId,
        target: old.frame.target,
        status: 'superseded',
        reason: 'new_request',
      })
    }
    const frame: AppOpenFrame = {
      kind: 'app.open',
      requestId,
      target,
      consumerId: this.#consumer,
      expiresAt: Date.now() + APP_NAVIGATION_TIMEOUT_MS,
    }
    return new Promise((resolve) => {
      const pending: Pending = {
        frame,
        callerId,
        resolve,
        timer: setTimeout(() => {
          this.#finish(pending, { requestId, target, status: 'unconfirmed', reason: 'ack_timeout' })
        }, APP_NAVIGATION_TIMEOUT_MS),
      }
      this.#pending = pending
      if (signal) {
        const abort = () => {
          this.deps.registry.publish(
            'app.navigate',
            { kind: 'app.open.cancel', requestId, consumerId: frame.consumerId },
            (params) => params['navigationConsumerId'] === frame.consumerId,
          )
          this.#finish(pending, {
            requestId,
            target,
            status: 'unconfirmed',
            reason: 'disconnected',
          })
        }
        signal.addEventListener('abort', abort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', abort)
      }
      this.deps.registry.publish(
        'app.navigate',
        frame,
        (params) => params['navigationConsumerId'] === frame.consumerId,
      )
    })
  }

  async validate(consumerId: string, requestId: string) {
    const pending = this.#matching(consumerId, requestId)
    if (!pending) throw new Error('Navigation request is no longer active.')
    try {
      await this.deps.validate(pending.callerId, pending.frame.target)
    } catch (error) {
      const receipt: AppOpenReceipt = {
        requestId,
        target: pending.frame.target,
        status: 'stale',
        reason:
          error instanceof ControlFailure && error.code === 'scope_denied'
            ? 'scope_changed'
            : 'target_changed',
      }
      this.#finish(pending, receipt)
      return { allowed: false as const, receipt }
    }
    if (!this.#matching(consumerId, requestId))
      return {
        allowed: false as const,
        receipt: pending.final ?? {
          requestId,
          target: pending.frame.target,
          status: 'unconfirmed' as const,
          reason: 'expired' as const,
        },
      }
    return { allowed: true as const }
  }

  async acknowledge(consumerId: string, raw: AppOpenReceipt): Promise<{ acknowledged: boolean }> {
    const receipt = appOpenReceiptSchema.parse(raw)
    const pending = this.#matching(consumerId, receipt.requestId)
    if (!pending || JSON.stringify(pending.frame.target) !== JSON.stringify(receipt.target))
      return { acknowledged: false }
    if (receipt.status === 'applied') {
      const valid = await this.validate(consumerId, receipt.requestId)
      if (!valid.allowed || !this.#matching(consumerId, receipt.requestId))
        return { acknowledged: false }
    }
    this.#finish(pending, receipt)
    return { acknowledged: true }
  }

  #matching(consumerId: string, requestId: string): Pending | null {
    const pending = this.#pending
    return pending &&
      this.#consumer === consumerId &&
      pending.frame.consumerId === consumerId &&
      pending.frame.requestId === requestId &&
      Date.now() < pending.frame.expiresAt
      ? pending
      : null
  }
  #finish(pending: Pending, receipt: AppOpenReceipt): void {
    if (this.#pending !== pending) return
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    pending.final = receipt
    this.#pending = null
    pending.resolve(receipt)
  }
}

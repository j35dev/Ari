import type { z } from 'zod'
import type { RpcMethod, RpcResults, StreamFrame, StreamName } from '@ari/contracts/rpc'
import { rpcParams } from '@ari/contracts/rpc'

/**
 * Pure RPC registry: method allowlist + payload validation + stream
 * subscription bookkeeping. No Electron imports so it is unit-testable.
 */

/** The schema-validated parameter type for a method. */
export type ParsedParams<M extends RpcMethod> = z.output<(typeof rpcParams)[M]>

export type InvokeHandler<M extends RpcMethod> = (
  params: ParsedParams<M>,
) => Promise<RpcResults[M]> | RpcResults[M]

export type HandlerMap = { [M in RpcMethod]?: InvokeHandler<M> }

export interface StreamSubscriber {
  id: string
  name: StreamName
  params: Record<string, unknown>
}

export interface RegistryDeps {
  /** Delivers a frame to the subscriber's transport. */
  send: (frame: StreamFrame) => void
}

export class RpcRegistry {
  readonly #handlers = new Map<RpcMethod, (params: unknown) => Promise<unknown>>()
  readonly #subscribers = new Map<string, StreamSubscriber>()
  readonly #deps: RegistryDeps

  constructor(deps: RegistryDeps) {
    this.#deps = deps
  }

  register<M extends RpcMethod>(method: M, handler: InvokeHandler<M>): void {
    const schema = rpcParams[method]
    this.#handlers.set(method, async (raw) => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`invalid params for ${method}: ${parsed.error.message}`)
      }
      return (handler as (p: unknown) => Promise<RpcResults[M]> | RpcResults[M])(parsed.data)
    })
  }

  hasHandler(method: RpcMethod): boolean {
    return this.#handlers.has(method)
  }

  async invoke(method: string, params: unknown): Promise<unknown> {
    const handler = this.#handlers.get(method as RpcMethod)
    if (!handler) throw new Error(`unknown method: ${method}`)
    return handler(params)
  }

  subscribe(sub: StreamSubscriber): void {
    this.#subscribers.set(sub.id, sub)
  }

  unsubscribe(id: string): void {
    this.#subscribers.delete(id)
  }

  subscriberCount(name?: StreamName): number {
    if (!name) return this.#subscribers.size
    let count = 0
    for (const sub of this.#subscribers.values()) if (sub.name === name) count++
    return count
  }

  /** Publishes to every subscriber of that stream. */
  publish<P>(name: StreamName, payload: P): void {
    for (const sub of this.#subscribers.values()) {
      if (sub.name === name) this.#deps.send({ id: sub.id, name, payload })
    }
  }
}

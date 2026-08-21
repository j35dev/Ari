import type { RpcMethod, RpcResults, StreamFrame, StreamName } from '@ari/contracts/rpc'

interface AriBridge {
  invoke: (method: string, params?: unknown) => Promise<unknown>
  subscribe: (id: string, callback: (frame: StreamFrame) => void) => () => void
}

declare global {
  interface Window {
    ari: AriBridge
  }
}

let subscriptionCounter = 0

/** Typed renderer-side RPC client over the sandboxed preload bridge. */
export const rpc = {
  async invoke<M extends RpcMethod>(
    method: M,
    params?: unknown,
  ): Promise<RpcResults[M]> {
    return window.ari.invoke(method, params) as Promise<RpcResults[M]>
  },

  subscribe<S extends StreamName>(
    name: S,
    params: Record<string, unknown>,
    onEvent: (payload: unknown) => void,
  ): () => void {
    const id = `sub_${++subscriptionCounter}_${Math.random().toString(36).slice(2, 8)}`
    const unsubscribeTransport = window.ari.subscribe(id, (frame) => onEvent(frame.payload))
    void window.ari.invoke('stream.subscribe', { id, name, params })
    return () => {
      unsubscribeTransport()
      void window.ari.invoke('stream.unsubscribe', { id })
    }
  },
}

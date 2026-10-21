import type { StreamBatchFrame, StreamFrame } from '@ari/contracts/rpc'

type Callback = (frame: StreamFrame) => void

/**
 * Routes frames from the single stream IPC channel to subscribers by id, so
 * each frame wakes only the callbacks it is addressed to instead of every
 * subscription's own channel listener.
 */
export class StreamRouter {
  readonly #callbacks = new Map<string, Set<Callback>>()

  /** Registers a callback for one subscription id; returns its removal. */
  subscribe(id: string, callback: Callback): () => void {
    let set = this.#callbacks.get(id)
    if (set === undefined) {
      set = new Set()
      this.#callbacks.set(id, set)
    }
    set.add(callback)
    return () => {
      const current = this.#callbacks.get(id)
      if (current === undefined) return
      current.delete(callback)
      if (current.size === 0) this.#callbacks.delete(id)
    }
  }

  dispatch(frame: StreamFrame | StreamBatchFrame): void {
    if ('ids' in frame) {
      for (const id of frame.ids) this.#deliver({ id, name: frame.name, payload: frame.payload })
    } else {
      this.#deliver(frame)
    }
  }

  #deliver(frame: StreamFrame): void {
    const set = this.#callbacks.get(frame.id)
    if (set === undefined) return
    for (const callback of [...set]) callback(frame)
  }
}

import type { SessionStore } from './session-store'
import { initialReadModel } from './projection'

type Store = Pick<
  SessionStore,
  'load' | 'loadExisting' | 'exists' | 'listSessions' | 'currentHelmSession'
>

/** Cancel supervisor reads on teardown, then drain writes already in flight. */
export class SupervisorStore {
  readonly store: Store
  #closed = false
  #cancel!: () => void
  #stopped: Promise<void>
  constructor(source: () => Store) {
    this.#stopped = new Promise<void>((resolve) => {
      this.#cancel = resolve
    })
    this.store = {
      load: (id) => this.#read(() => source().load(id), initialReadModel()),
      loadExisting: (id) => this.#read(() => source().loadExisting(id), null),
      exists: (id) => this.#read(() => source().exists(id), false),
      listSessions: () => this.#read(() => source().listSessions(), []),
      currentHelmSession: () => this.#read(() => source().currentHelmSession(), null),
    }
  }
  start(): void {
    if (!this.#closed) return
    this.#closed = false
    this.#stopped = new Promise<void>((resolve) => {
      this.#cancel = resolve
    })
  }
  close(): void {
    this.#closed = true
    this.#cancel()
  }
  async #read<T>(fetch: () => Promise<T>, fallback: T): Promise<T> {
    if (this.#closed) return fallback
    return Promise.race([fetch(), this.#stopped.then(() => fallback)])
  }
}

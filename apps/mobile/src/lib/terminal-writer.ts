interface Chunk {
  data: string
  resolve: () => void
  reject: (error: unknown) => void
}
interface Pending {
  data: string
  key: string
  chunks: Chunk[]
}

/** Preserve PTY input order and the same receipt when an acknowledgement is lost. */
export class TerminalWriter {
  readonly #send: (data: string, key: string) => Promise<void>
  readonly #onError: (error: unknown) => void
  readonly #queue: Chunk[] = []
  #pending: Pending | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #running = false
  #blocked = false
  #closed = false
  constructor(
    send: (data: string, key: string) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.#send = send
    this.#onError = onError
  }

  write(data: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('The terminal input connection is closed.'))
    if (this.#blocked)
      return Promise.reject(new Error('Retry the pending terminal input before sending more.'))
    if (
      data.length +
        this.#queue.reduce(
          (size, chunk) => size + chunk.data.length,
          this.#pending?.data.length ?? 0,
        ) >
      65536
    )
      return Promise.reject(new Error('Terminal input exceeded the 64 KB queue limit.'))
    const promises: Promise<void>[] = []
    for (let offset = 0; offset < data.length; offset += 16384)
      promises.push(
        new Promise<void>((resolve, reject) => {
          this.#queue.push({ data: data.slice(offset, offset + 16384), resolve, reject })
        }),
      )
    if (this.#timer === null && !this.#running)
      this.#timer = setTimeout(() => {
        this.#timer = null
        void this.#flush()
      }, 80)
    return Promise.all(promises).then(() => undefined)
  }

  async retry(): Promise<void> {
    if (this.#closed) throw new Error('The terminal input connection is closed.')
    this.#blocked = false
    await this.#flush()
    if (this.#blocked)
      throw new Error('Terminal input is still unacknowledged. Retry the same input.')
  }

  dispose(): void {
    this.#closed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    const error = new Error('Terminal input closed before acknowledgement.')
    for (const chunk of [...(this.#pending?.chunks ?? []), ...this.#queue]) chunk.reject(error)
    this.#queue.length = 0
    this.#pending = null
  }

  async #flush(): Promise<void> {
    if (this.#running || this.#closed || this.#blocked) return
    this.#running = true
    try {
      while (!this.#closed && (this.#pending !== null || this.#queue.length > 0)) {
        if (this.#pending === null) {
          const chunks: Chunk[] = []
          let data = ''
          while (
            this.#queue[0] !== undefined &&
            data.length + this.#queue[0].data.length <= 16384
          ) {
            const chunk = this.#queue.shift()
            if (chunk === undefined) break
            chunks.push(chunk)
            data += chunk.data
          }
          this.#pending = { data, chunks, key: crypto.randomUUID() }
        }
        const pending = this.#pending
        try {
          await this.#send(pending.data, pending.key)
          for (const chunk of pending.chunks) chunk.resolve()
          if (this.#pending === pending) this.#pending = null
        } catch (error) {
          this.#blocked = true
          for (const chunk of pending.chunks) chunk.reject(error)
          if (!this.#closed) this.#onError(error)
          break
        }
      }
    } finally {
      this.#running = false
    }
  }
}

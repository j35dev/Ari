/** A single-consumer stream. Ending wakes a reader without ending its owner query. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = []
  #wake: (() => void) | null = null
  #ended = false

  push(item: T): boolean {
    if (this.#ended) return false
    this.#items.push(item)
    this.#wake?.()
    this.#wake = null
    return true
  }

  end(): void {
    this.#ended = true
    this.#wake?.()
    this.#wake = null
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.#items.length > 0) yield this.#items.shift()!
      if (this.#ended) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}

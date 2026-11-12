import type { DeviceRecord, DeviceStore } from './device-key'

/** A forgotten connection cannot repopulate its key store after a delayed async response. */
export class LifecycleDeviceStore implements DeviceStore {
  readonly #store: DeviceStore
  #retired = false
  #writes: Promise<void> = Promise.resolve()
  constructor(store: DeviceStore) { this.#store = store }

  async loadKey(): Promise<CryptoKeyPair | null> {
    if (this.#retired) return null
    const key = await this.#store.loadKey()
    return this.#retired ? null : key
  }
  async loadRecord(): Promise<DeviceRecord | null> {
    if (this.#retired) return null
    const record = await this.#store.loadRecord()
    return this.#retired ? null : record
  }
  #write(action: () => Promise<void>): Promise<void> {
    const write = this.#writes.then(async () => {
      if (this.#retired) throw new DOMException('This computer was forgotten.', 'AbortError')
      await action()
      if (this.#retired) throw new DOMException('This computer was forgotten.', 'AbortError')
    })
    this.#writes = write.catch(() => undefined)
    return write
  }
  saveKey(pair: CryptoKeyPair): Promise<void> { return this.#write(() => this.#store.saveKey(pair)) }
  saveRecord(record: DeviceRecord): Promise<void> { return this.#write(() => this.#store.saveRecord(record)) }
  clear(): Promise<void> {
    this.#retired = true
    // Only local storage writes are ordered before clear, never gateway requests.
    const clear = this.#writes.then(() => this.#store.clear())
    this.#writes = clear.catch(() => undefined)
    return clear
  }
}

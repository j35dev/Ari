import type { PairingPublicKey } from '@ari/contracts/remote'

/**
 * The phone's identity (ADR §9).
 *
 * A non-extractable ECDSA P-256 key, generated in Web Crypto and kept in
 * IndexedDB. Non-extractable means the key material cannot be read back out
 * by script — a same-origin compromise can *use* it while the page is open,
 * but cannot copy it to another machine. That is a real limit, not a
 * guarantee, and it is why the desktop still requires an explicit approval for
 * every new device rather than trusting a key on its own.
 *
 * The key is the durable credential; the bearer token the gateway hands back
 * is not, and is deliberately never written down.
 */

export interface DeviceRecord {
  deviceId: string
  displayName: string
  /** Projects the user granted at the desktop; shown in Settings. */
  projectIds: string[]
}

/** Where the key and the device id live. Swapped out in tests. */
export interface DeviceStore {
  loadKey(): Promise<CryptoKeyPair | null>
  saveKey(pair: CryptoKeyPair): Promise<void>
  loadRecord(): Promise<DeviceRecord | null>
  saveRecord(record: DeviceRecord): Promise<void>
  clear(): Promise<void>
}

export class DeviceKeyring {
  readonly #store: DeviceStore
  #key: CryptoKeyPair | null = null
  #record: DeviceRecord | null = null

  constructor(store: DeviceStore) {
    this.#store = store
  }

  /** The device this browser is registered as, or null before pairing. */
  get deviceId(): string | null {
    return this.#record?.deviceId ?? null
  }

  get record(): DeviceRecord | null {
    return this.#record
  }

  async load(): Promise<void> {
    this.#key = await this.#store.loadKey()
    this.#record = await this.#store.loadRecord()
  }

  /** The key, generated on first use. */
  async key(): Promise<CryptoKeyPair> {
    if (this.#key !== null) return this.#key
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      // The private half is what must not be readable by script; the public
      // half is exportable regardless, since registering it is the point.
      false,
      ['sign', 'verify'],
    )
    await this.#store.saveKey(pair)
    this.#key = pair
    return pair
  }

  async publicKey(): Promise<PairingPublicKey> {
    const { publicKey } = await this.key()
    const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as {
      kty?: string
      crv?: string
      x?: string
      y?: string
    }
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.x === undefined || jwk.y === undefined) {
      throw new Error('the browser produced a key this protocol cannot register')
    }
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
  }

  /**
   * Signs a server-issued nonce. The signature is DER-encoded, which is what
   * the gateway verifies: Web Crypto returns the raw `r || s` pair, and the
   * conversion is the one piece of this file that is not obvious.
   */
  async sign(nonce: string): Promise<string> {
    const { privateKey } = await this.key()
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode(nonce),
      ),
    )
    return bytesToBase64(rawSignatureToDer(raw))
  }

  async remember(record: DeviceRecord): Promise<void> {
    await this.#store.saveRecord(record)
    this.#record = record
  }

  /**
   * Forgets this browser's identity. Only ever an explicit act: clearing the
   * key silently would leave the desktop listing a device that can never come
   * back, and the user with no way to tell why.
   */
  async forget(): Promise<void> {
    await this.#store.clear()
    this.#key = null
    this.#record = null
  }
}

/**
 * `[0x30, len, 0x02, rLen, r..., 0x02, sLen, s...]`.
 *
 * P-256 halves are 32 bytes and the lengths stay under 0x80, so the short
 * form is always correct here; the leading zero is added only when a half's
 * high bit is set, because a DER INTEGER is two's complement and would
 * otherwise read as negative.
 */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error(`expected a 64-byte P-256 signature, got ${raw.length}`)
  const r = derInteger(raw.subarray(0, 32))
  const s = derInteger(raw.subarray(32))
  const body = [...r, ...s]
  return new Uint8Array([0x30, body.length, ...body])
}

function derInteger(half: Uint8Array): number[] {
  let start = 0
  while (start < half.length - 1 && half[start] === 0) start++
  const bytes = Array.from(half.subarray(start))
  const first = bytes[0] ?? 0
  if ((first & 0x80) !== 0) bytes.unshift(0)
  return [0x02, bytes.length, ...bytes]
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** IndexedDB-backed store: the key and the device record, nothing else. */
export class IndexedDbDeviceStore implements DeviceStore {
  readonly #name: string

  constructor(name = 'ari-mobile') {
    this.#name = name
  }

  async loadKey(): Promise<CryptoKeyPair | null> {
    return (await this.#read<CryptoKeyPair>('key')) ?? null
  }

  async saveKey(pair: CryptoKeyPair): Promise<void> {
    await this.#write('key', pair)
  }

  async loadRecord(): Promise<DeviceRecord | null> {
    return (await this.#read<DeviceRecord>('device')) ?? null
  }

  async saveRecord(record: DeviceRecord): Promise<void> {
    await this.#write('device', record)
  }

  async clear(): Promise<void> {
    const db = await this.#open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('could not clear stored records'))
    })
    db.close()
  }

  async #read<T>(key: string): Promise<T | undefined> {
    const db = await this.#open()
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction('records', 'readonly')
      const request = tx.objectStore('records').get(key)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error ?? new Error('could not read a stored record'))
    })
    db.close()
    return value
  }

  async #write(key: string, value: unknown): Promise<void> {
    const db = await this.#open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite')
      tx.objectStore('records').put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('could not store a record'))
    })
    db.close()
  }

  #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#name, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('records')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('could not open local storage'))
    })
  }
}

/** In-memory store for environments without IndexedDB (tests, private modes). */
export class MemoryDeviceStore implements DeviceStore {
  #key: CryptoKeyPair | null = null
  #record: DeviceRecord | null = null

  async loadKey(): Promise<CryptoKeyPair | null> {
    return this.#key
  }

  async saveKey(pair: CryptoKeyPair): Promise<void> {
    this.#key = pair
  }

  async loadRecord(): Promise<DeviceRecord | null> {
    return this.#record
  }

  async saveRecord(record: DeviceRecord): Promise<void> {
    this.#record = record
  }

  async clear(): Promise<void> {
    this.#key = null
    this.#record = null
  }
}

/**
 * Picks the best store the browser will actually give us.
 *
 * Some privacy modes expose `indexedDB` and then fail every transaction, so
 * this probes with a real write rather than trusting the property to exist.
 */
export async function defaultDeviceStore(): Promise<DeviceStore> {
  if (typeof indexedDB === 'undefined') return new MemoryDeviceStore()
  const store = new IndexedDbDeviceStore()
  try {
    await store.saveRecord({ deviceId: 'probe', displayName: 'probe', projectIds: [] })
    await store.clear()
    return store
  } catch {
    return new MemoryDeviceStore()
  }
}

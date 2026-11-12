import { createHash } from 'node:crypto'

/**
 * Idempotency for remote mutations.
 *
 * Every mutating command carries a client-generated key. The gateway records
 * the key, a fingerprint of the payload it was first seen with, and the
 * outcome, so a client that retries after a timeout — or after the desktop
 * restarted mid-command — gets the original outcome instead of a second
 * execution. Session creation and prompts are where a duplicate is visible to
 * the user, so a duplicate here is not a cosmetic problem.
 *
 * The fingerprint is order-insensitive: a client that serializes its JSON
 * differently between attempts is still recognized, because the alternative
 * is a spurious conflict on a retry that should have replayed.
 */

export type IdempotencyOutcome<T> =
  | { outcome: 'fresh' }
  | { outcome: 'capacity' }
  | { outcome: 'in_flight' }
  | { outcome: 'conflict' }
  | { outcome: 'replay'; result: T | undefined }

interface Record_<T> {
  fingerprint: string
  /** Absent while the command is still running. */
  result?: T
  failed?: boolean
  at: number
}

interface Options {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 1000

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function fingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

export class IdempotencyStore<T = unknown> {
  readonly #records = new Map<string, Record_<T>>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #maxEntries: number

  constructor(options: Options = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  get size(): number {
    return this.#records.size
  }

  /**
   * Claims a key for this attempt.
   *
   * `fresh` means the caller owns the command and must run it. `in_flight` and
   * `replay` both mean someone already has; `conflict` means the key was
   * reused for something else, which is a client bug worth surfacing rather
   * than quietly applying.
   */
  begin(key: string, payload: unknown): IdempotencyOutcome<T> {
    const fingerprintNow = fingerprint(payload)
    const existing = this.#records.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprintNow) return { outcome: 'conflict' }
      if (existing.result === undefined && existing.failed !== true) {
        return { outcome: 'in_flight' }
      }
      return { outcome: 'replay', result: existing.result }
    }
    if (!this.#makeRoom()) return { outcome: 'capacity' }
    this.#records.set(key, { fingerprint: fingerprintNow, at: this.#now() })
    return { outcome: 'fresh' }
  }

  complete(key: string, result: T): void {
    const record = this.#records.get(key)
    if (record === undefined) return
    record.result = result
    record.at = this.#now()
  }

  /**
   * Records that the command failed. The key stays claimed: a retry replays
   * the failure rather than executing, so a command that failed after it had
   * already taken effect is never applied twice.
   */
  fail(key: string): void {
    const record = this.#records.get(key)
    if (record === undefined) return
    record.failed = true
    record.result = undefined
    record.at = this.#now()
  }

  lookup(key: string): { result?: T; failed: boolean; at: number } | undefined {
    const record = this.#records.get(key)
    if (record === undefined) return undefined
    return { result: record.result, failed: record.failed === true, at: record.at }
  }

  /** Drops records past their TTL. Returns how many went. */
  prune(): number {
    const cutoff = this.#now() - this.#ttlMs
    let dropped = 0
    for (const [key, record] of this.#records) {
      if (record.at < cutoff && (record.result !== undefined || record.failed === true)) {
        this.#records.delete(key)
        dropped++
      }
    }
    return dropped
  }

  toJSON(): string {
    return JSON.stringify([...this.#records.entries()])
  }

  static fromJSON<T>(
    json: string,
    validateResult?: (result: unknown) => result is T,
  ): IdempotencyStore<T> {
    const store = new IdempotencyStore<T>()
    const entries: unknown = JSON.parse(json)
    if (!Array.isArray(entries)) throw new Error('Remote command history is not an array')
    if (entries.length > store.#maxEntries)
      throw new Error('Remote command history exceeds capacity')
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2)
        throw new Error('Invalid remote command history entry')
      const [key, value] = entry as unknown[]
      if (
        typeof key !== 'string' ||
        key.length === 0 ||
        store.#records.has(key) ||
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
      )
        throw new Error('Invalid remote command history entry')
      const record = value as Record<string, unknown>
      if (
        record['result'] !== undefined &&
        validateResult !== undefined &&
        !validateResult(record['result'])
      )
        throw new Error('Invalid remote command history outcome')
      if (
        typeof record['fingerprint'] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record['fingerprint']) ||
        typeof record['at'] !== 'number' ||
        !Number.isFinite(record['at']) ||
        record['at'] < 0 ||
        (record['failed'] !== undefined && typeof record['failed'] !== 'boolean') ||
        (record['failed'] === true && record['result'] !== undefined) ||
        Object.keys(record).some(
          (field) => !['fingerprint', 'at', 'failed', 'result'].includes(field),
        )
      )
        throw new Error('Invalid remote command history record')
      store.#records.set(key, value as Record_<T>)
    }
    return store
  }

  /** Oldest first, so the longest-remembered keys go before recent ones. */
  #makeRoom(): boolean {
    if (this.#records.size < this.#maxEntries) return true
    let oldestKey: string | undefined
    let oldest = Infinity
    for (const [key, record] of this.#records) {
      if ((record.result !== undefined || record.failed === true) && record.at < oldest) {
        oldest = record.at
        oldestKey = key
      }
    }
    if (oldestKey === undefined) return false
    this.#records.delete(oldestKey)
    return true
  }
}

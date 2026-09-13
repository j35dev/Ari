import { describe, expect, it } from 'vitest'
import { IdempotencyStore } from './idempotency'

const COMMAND = { op: 'session.prompt', sessionId: 'sess_1', text: 'hello' }

describe('idempotency store', () => {
  it('lets a first command through', () => {
    const store = new IdempotencyStore()
    expect(store.begin('key-1', COMMAND)).toEqual({ outcome: 'fresh' })
  })

  it('replays the recorded outcome instead of running the command twice', () => {
    const store = new IdempotencyStore()
    store.begin('key-1', COMMAND)
    store.complete('key-1', { accepted: true, commandId: 'cmd_1' })
    expect(store.begin('key-1', COMMAND)).toEqual({
      outcome: 'replay',
      result: { accepted: true, commandId: 'cmd_1' },
    })
  })

  it('rejects a key reused with a different payload', () => {
    const store = new IdempotencyStore()
    store.begin('key-1', COMMAND)
    expect(store.begin('key-1', { ...COMMAND, text: 'something else' })).toEqual({
      outcome: 'conflict',
    })
  })

  it('ignores key order when fingerprinting the payload', () => {
    const store = new IdempotencyStore()
    store.begin('key-1', { op: 'a', sessionId: 's', text: 't' })
    expect(store.begin('key-1', { text: 't', sessionId: 's', op: 'a' })).not.toEqual({
      outcome: 'conflict',
    })
  })

  it('reports a key whose command is still in flight as in-flight, not fresh', () => {
    // A client that retries while the first attempt is running must not have
    // the command applied a second time.
    const store = new IdempotencyStore()
    store.begin('key-1', COMMAND)
    expect(store.begin('key-1', COMMAND)).toEqual({ outcome: 'in_flight' })
  })

  it('records a failure so a retry does not silently succeed later', () => {
    const store = new IdempotencyStore()
    store.begin('key-1', COMMAND)
    store.fail('key-1')
    expect(store.begin('key-1', COMMAND)).toEqual({ outcome: 'replay', result: undefined })
  })

  it('forgets nothing when asked for an unknown key', () => {
    const store = new IdempotencyStore()
    expect(store.lookup('never-seen')).toBeUndefined()
  })

  it('survives a round trip through its serialized form', () => {
    // Records outlive a desktop restart, so a client retrying after a crash
    // still gets the original outcome rather than a second execution.
    const store = new IdempotencyStore()
    store.begin('key-1', COMMAND)
    store.complete('key-1', { accepted: true, commandId: 'cmd_1' })
    const restored = IdempotencyStore.fromJSON(store.toJSON())
    expect(restored.begin('key-1', COMMAND)).toEqual({
      outcome: 'replay',
      result: { accepted: true, commandId: 'cmd_1' },
    })
  })

  it('drops records too old to matter, and keeps recent ones', () => {
    let now = 1_000
    const store = new IdempotencyStore({ now: () => now, ttlMs: 500 })
    store.begin('old', COMMAND)
    store.complete('old', { accepted: true })
    now = 1_200
    store.begin('new', { ...COMMAND, text: 'newer' })
    store.complete('new', { accepted: true })

    now = 1_600
    const pruned = store.prune()
    expect(pruned).toBe(1)
    expect(store.lookup('old')).toBeUndefined()
    expect(store.lookup('new')).toBeDefined()
  })

  it('bounds how much it remembers', () => {
    const store = new IdempotencyStore({ maxEntries: 2 })
    store.begin('a', { ...COMMAND, text: 'a' })
    store.complete('a', { accepted: true })
    store.begin('b', { ...COMMAND, text: 'b' })
    store.complete('b', { accepted: true })
    store.begin('c', { ...COMMAND, text: 'c' })
    store.complete('c', { accepted: true })
    expect(store.size).toBe(2)
    expect(store.lookup('a')).toBeUndefined()
  })
})

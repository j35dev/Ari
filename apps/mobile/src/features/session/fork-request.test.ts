// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForkRequestStore } from './fork-request'

const request = {
  key: 'receipt_test',
  title: 'Review mobile',
  driverKind: 'claude' as const,
  modelId: 'claude-sonnet-4-6',
}
beforeEach(() => {
  sessionStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('ForkRequestStore', () => {
  it('restores only the original computer, paired device, and parent receipt', () => {
    const store = new ForkRequestStore('https://ari.example.com', 'phone_a', 'sess_parent')
    store.write(request)
    expect(store.read()).toEqual(request)
    expect(
      new ForkRequestStore('https://other.example.com', 'phone_a', 'sess_parent').read(),
    ).toBeNull()
    expect(
      new ForkRequestStore('https://ari.example.com', 'phone_b', 'sess_parent').read(),
    ).toBeNull()
    expect(
      new ForkRequestStore('https://ari.example.com', 'phone_a', 'sess_other').read(),
    ).toBeNull()
    store.clear()
    expect(store.read()).toBeNull()
  })

  it('never stores a request without a paired device and computer', () => {
    expect(() => new ForkRequestStore(null, 'phone_a', 'sess_parent').write(request)).toThrow(
      'Reconnect',
    )
    expect(() =>
      new ForkRequestStore('https://ari.example.com', null, 'sess_parent').write(request),
    ).toThrow('Reconnect')
  })

  it.each(['malformed', 'wrong-parent', 'wrong-operation', 'wrong-receipt', 'invalid-provider'])(
    'discards %s storage',
    (kind) => {
      const store = new ForkRequestStore('https://ari.example.com', 'phone_a', 'sess_parent')
      store.write(request)
      const key = sessionStorage.key(0)!
      const value = JSON.parse(sessionStorage.getItem(key)!) as Record<string, unknown>
      if (kind === 'wrong-parent') value['sessionId'] = 'sess_other'
      if (kind === 'wrong-operation') value['op'] = 'session.prompt'
      if (kind === 'wrong-receipt') value['clientCommandId'] = 'other_receipt'
      if (kind === 'invalid-provider') value['driverKind'] = 'unknown'
      sessionStorage.setItem(key, kind === 'malformed' ? '{' : JSON.stringify(value))
      expect(store.read()).toBeNull()
    },
  )

  it('does not fail a confirmed navigation when storage removal fails', () => {
    const store = new ForkRequestStore('https://ari.example.com', 'phone_a', 'sess_parent')
    store.write(request)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Blocked')
    })
    expect(() => store.clear()).not.toThrow()
    expect(store.read()).toEqual(request)
  })
})

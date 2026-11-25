import { afterEach, describe, expect, it } from 'vitest'
import { rpc, stripRemotePrefix } from './rpc'

describe('stripRemotePrefix', () => {
  it('drops Electron’s transport wording and the error class', () => {
    expect(
      stripRemotePrefix(
        "Error invoking remote method 'ari:session.prompt': Error: provider exited",
      ),
    ).toBe('provider exited')
    expect(stripRemotePrefix("Error invoking remote method 'ari:x': TypeError: bad")).toBe('bad')
    expect(stripRemotePrefix('already clean')).toBe('already clean')
  })
})

describe('rpc.invoke', () => {
  const original = window.ari
  afterEach(() => {
    window.ari = original
  })

  it('rejects with the handler’s own message', async () => {
    window.ari = {
      invoke: () =>
        Promise.reject(new Error("Error invoking remote method 'ari:ping': Error: no engine")),
      subscribe: () => () => undefined,
    }
    await expect(rpc.invoke('ping')).rejects.toThrow(/^no engine$/)
  })
})

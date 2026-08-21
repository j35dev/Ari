import { describe, expect, it, vi } from 'vitest'
import type { StreamFrame } from '@ari/contracts/rpc'
import { RpcRegistry } from './rpc-registry'

function makeRegistry() {
  const sent: StreamFrame[] = []
  const registry = new RpcRegistry({ send: (frame) => sent.push(frame) })
  return { registry, sent }
}

describe('RpcRegistry', () => {
  it('validates params against the contract schema before invoking', async () => {
    const { registry } = makeRegistry()
    const handler = vi.fn(() => Promise.resolve({ destroyed: true }))
    registry.register('session.destroy', handler)

    await expect(registry.invoke('session.destroy', {})).rejects.toThrow(/invalid params/)
    expect(handler).not.toHaveBeenCalled()

    await registry.invoke('session.destroy', { sessionId: 'sess_1' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects unknown methods and unregistered known methods', async () => {
    const { registry } = makeRegistry()
    await expect(registry.invoke('nope', undefined)).rejects.toThrow(/unknown method/)
    await expect(registry.invoke('ping', undefined)).rejects.toThrow(/unknown method/)
  })

  it('publishes frames only to subscribers of that stream', () => {
    const { registry, sent } = makeRegistry()
    registry.subscribe({ id: 'a', name: 'session.events', params: { sessionId: 's1' } })
    registry.subscribe({ id: 'b', name: 'session.events', params: { sessionId: 's2' } })

    registry.publish('session.events', { seq: 1 })
    expect(sent).toHaveLength(2)
    expect(sent.map((f) => f.id).sort()).toEqual(['a', 'b'])
  })

  it('unsubscribe stops delivery and subscriberCount tracks by name', () => {
    const { registry } = makeRegistry()
    registry.subscribe({ id: 'a', name: 'session.events', params: {} })
    expect(registry.subscriberCount('session.events')).toBe(1)
    registry.unsubscribe('a')
    expect(registry.subscriberCount('session.events')).toBe(0)
  })
})

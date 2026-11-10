// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ControlFailure } from '@ari/contracts/agent-control'
import type { AppOpenFrame, AppOpenReceipt, StreamFrame } from '@ari/contracts/rpc'
import { AppNavigation, APP_NAVIGATION_TIMEOUT_MS } from './app-navigation'
import { RpcRegistry } from './rpc-registry'

let sent: StreamFrame[]
let registry: RpcRegistry
let navigation: AppNavigation
let validate: ReturnType<typeof vi.fn<() => Promise<void>>>
const target = { view: 'session' as const, sessionId: 'session' }
beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  registry = new RpcRegistry({ send: (frame) => sent.push(frame) })
  validate = vi.fn(async () => undefined)
  navigation = new AppNavigation({ registry, validate })
  registry.register('app.navigation.consumer', ({ consumerId, connected }) =>
    navigation.consumer(consumerId, connected),
  )
  registry.register('app.navigation.validate', ({ consumerId, requestId }) =>
    navigation.validate(consumerId, requestId),
  )
  registry.register('app.navigation.ack', ({ consumerId, receipt }) =>
    navigation.acknowledge(consumerId, receipt),
  )
})
afterEach(() => {
  navigation.reset()
  vi.useRealTimers()
})
function ready(id = 'shell') {
  registry.subscribe({ id, name: 'app.navigate', params: { navigationConsumerId: id } })
  navigation.consumer(id, true)
}
function receipt(frame: AppOpenFrame): AppOpenReceipt {
  return {
    requestId: frame.requestId,
    target: frame.target,
    status: 'applied',
    observed: { target: frame.target, mode: 'chat' },
  }
}

it('publication has no applied claim; only the selected consumer can acknowledge', async () => {
  ready('old')
  ready('shell')
  const result = navigation.open('aria', target, 'r')
  const frame = sent[0]!.payload as AppOpenFrame
  expect(sent.map((frame) => frame.id)).toEqual(['shell'])
  let settled = false
  void result.then(() => {
    settled = true
  })
  expect(
    await registry.invoke('app.navigation.ack', { consumerId: 'old', receipt: receipt(frame) }),
  ).toEqual({ acknowledged: false })
  expect(
    await registry.invoke('app.navigation.ack', {
      consumerId: 'shell',
      receipt: {
        ...receipt(frame),
        target: { view: 'session', sessionId: 'other' },
        observed: { target: { view: 'session', sessionId: 'other' }, mode: 'chat' },
      },
    }),
  ).toEqual({ acknowledged: false })
  expect(settled).toBe(false)
  await expect(
    registry.invoke('app.navigation.ack', {
      consumerId: 'shell',
      receipt: { ...receipt(frame), observed: undefined },
    }),
  ).rejects.toThrow(/invalid params/)
  expect(
    await registry.invoke('app.navigation.ack', { consumerId: 'shell', receipt: receipt(frame) }),
  ).toEqual({ acknowledged: true })
  expect(await result).toEqual(receipt(frame))
  expect(validate).toHaveBeenCalledOnce()
})

it('reports missing consumers, timeout and late acknowledgement without resend', async () => {
  expect(await navigation.open('aria', target, 'missing')).toMatchObject({
    status: 'unavailable',
    reason: 'no_consumer',
  })
  ready()
  const result = navigation.open('aria', target, 'late')
  const frame = sent[0]!.payload as AppOpenFrame
  await vi.advanceTimersByTimeAsync(APP_NAVIGATION_TIMEOUT_MS)
  expect(await result).toMatchObject({ status: 'unconfirmed', reason: 'ack_timeout' })
  expect(await navigation.acknowledge('shell', receipt(frame))).toEqual({ acknowledged: false })
  expect(sent).toHaveLength(1)
})

it('cancels disconnect, replacement and newer requests at the exact consumer boundary', async () => {
  ready()
  const disconnected = navigation.open('aria', target, 'disconnect')
  navigation.reset()
  expect(await disconnected).toMatchObject({ status: 'unconfirmed', reason: 'disconnected' })
  ready()
  const replaced = navigation.open('aria', target, 'replace')
  ready('new')
  expect(await replaced).toMatchObject({ status: 'unconfirmed', reason: 'consumer_replaced' })
  navigation.consumer('shell', false)
  const first = navigation.open('aria', target, 'first')
  const second = navigation.open('aria', target, 'second')
  expect(await first).toMatchObject({ status: 'superseded', reason: 'new_request' })
  expect(sent.at(-1)!.id).toBe('new')
  navigation.reset()
  await second
})

it('revalidates after delayed loads and refuses targets or scopes that changed', async () => {
  ready()
  const result = navigation.open('aria', target, 'stale')
  validate.mockRejectedValueOnce(new ControlFailure('scope_denied', 'topic replaced'))
  expect(await navigation.validate('shell', 'stale')).toMatchObject({
    allowed: false,
    receipt: { status: 'stale', reason: 'scope_changed' },
  })
  expect(await result).toMatchObject({ status: 'stale', target })
  let resolve!: () => void
  validate.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  const delayed = navigation.open('aria', target, 'delayed')
  const checking = navigation.validate('shell', 'delayed')
  navigation.reset()
  resolve()
  expect(await checking).toMatchObject({
    allowed: false,
    receipt: { status: 'unconfirmed', reason: 'disconnected' },
  })
  await delayed
})

it('cancels only the disconnected requester and never publishes an already aborted request', async () => {
  ready()
  const signal = new AbortController()
  const result = navigation.open('aria', target, 'abort', signal.signal)
  signal.abort()
  expect(await result).toMatchObject({ status: 'unconfirmed', reason: 'disconnected', target })
  expect(sent.at(-1)?.payload).toEqual({
    kind: 'app.open.cancel',
    consumerId: 'shell',
    requestId: 'abort',
  })
  expect(await navigation.open('aria', target, 'already-aborted', signal.signal)).toMatchObject({
    status: 'unavailable',
    reason: 'disconnected',
  })
  const next = navigation.open('aria', target, 'next')
  const frame = sent.at(-1)!.payload as AppOpenFrame
  expect(await navigation.acknowledge('shell', receipt(frame))).toEqual({ acknowledged: true })
  expect(await next).toMatchObject({ status: 'applied' })
})

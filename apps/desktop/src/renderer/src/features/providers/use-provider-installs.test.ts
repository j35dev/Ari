import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProvidersUpdateFrame } from '@ari/contracts/rpc'
import { useProviderInstalls } from './use-provider-installs'

const { invoke, subscribe } = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke, subscribe } }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function setup() {
  let listener!: (frame: ProvidersUpdateFrame) => void
  subscribe.mockImplementation((_topic, _params, callback) => {
    listener = callback
    return () => undefined
  })
  const hook = renderHook(() => useProviderInstalls(() => undefined))
  const emit = (frame: ProvidersUpdateFrame) => act(() => listener(frame))
  return { ...hook, emit }
}

describe('provider install state', () => {
  it('keeps failures available for Retry after the success display timeout', () => {
    vi.useFakeTimers()
    const h = setup()
    h.emit({
      type: 'install.settled',
      kind: 'codex',
      operation: 'upgrade',
      ok: false,
      reason: 'CLI is locked.',
      truncated: false,
      details: 'EPERM',
    })
    act(() => vi.advanceTimersByTime(60_000))
    expect(h.result.current.installs.codex).toMatchObject({
      outcome: { ok: false },
      details: 'EPERM',
    })
    h.unmount()
  })

  it('clears successful status after eight seconds', () => {
    vi.useFakeTimers()
    const h = setup()
    h.emit({
      type: 'install.settled',
      kind: 'codex',
      operation: 'upgrade',
      ok: true,
      reason: null,
      truncated: false,
    })
    act(() => vi.advanceTimersByTime(8000))
    expect(h.result.current.installs.codex).toBeUndefined()
    h.unmount()
  })

  it('captures phase messages and bounds streamed details', () => {
    const h = setup()
    h.emit({ type: 'install.started', kind: 'codex', operation: 'upgrade' })
    h.emit({
      type: 'install.phase',
      kind: 'codex',
      phase: 'verifying',
      message: 'Checking the version…',
    })
    h.emit({ type: 'install.progress', kind: 'codex', stream: 'stderr', text: 'x'.repeat(20_000) })
    expect(h.result.current.installs.codex).toMatchObject({
      phase: 'verifying',
      message: 'Checking the version…',
    })
    expect(h.result.current.installs.codex?.details?.length).toBe(10_240)
    h.unmount()
  })
})

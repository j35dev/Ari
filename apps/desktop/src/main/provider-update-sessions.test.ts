// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { providerUpdateSessions } from './provider-update-sessions'

function harness() {
  const pending = new Set(['parked'])
  const live = new Set<string>()
  const release = vi.fn(async (_id: string): Promise<void | boolean> => undefined)
  const list = vi.fn(async () => [
    { id: 'parked', driverKind: 'claude' },
    { id: 'other', driverKind: 'claude' },
    { id: 'codex', driverKind: 'codex' },
  ])
  const sessions = providerUpdateSessions({
    list,
    liveTurn: (id) => live.has(id),
    backgroundWork: (id) => pending.has(id),
    probesBusy: () => false,
    release,
  })
  return { sessions, pending, live, release }
}

describe('provider update session safety', () => {
  it('waits for parked work and counts sessions instead of tearing them down', async () => {
    const h = harness()
    expect(await h.sessions.busy('claude')).toBe('Waiting for background work in 1 session…')
    expect(await h.sessions.release('claude')).toBe(false)
    expect(h.release).not.toHaveBeenCalled()
    h.pending.add('other')
    expect(await h.sessions.busy('claude')).toBe('Waiting for background work in 2 sessions…')
    h.pending.clear()
    expect(await h.sessions.busy('claude')).toBe(false)
    expect(await h.sessions.release('claude')).toBe(true)
    expect(h.release.mock.calls).toEqual([['parked'], ['other']])
  })

  it('rechecks each connection if background work appears while closing another idle one', async () => {
    const h = harness()
    h.pending.clear()
    h.release.mockImplementationOnce(async () => {
      h.pending.add('other')
    })
    expect(await h.sessions.release('claude')).toBe(false)
    expect(h.release.mock.calls).toEqual([['parked']])
    expect(await h.sessions.busy('claude')).toBe('Waiting for background work in 1 session…')
  })

  it('also waits for a live turn and permits unrelated providers', async () => {
    const h = harness()
    h.pending.clear()
    h.live.add('parked')
    expect(await h.sessions.busy('claude')).toBe(true)
    expect(await h.sessions.release('claude')).toBe(false)
    expect(await h.sessions.busy('codex')).toBe(false)
    expect(await h.sessions.release('codex')).toBe(true)
    expect(h.release).toHaveBeenCalledWith('codex')
  })
})

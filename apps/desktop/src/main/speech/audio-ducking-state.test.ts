// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { DuckingState, type DuckedVolume, type OutputSession } from './audio-ducking-state'

function playback(id: string, initial = [0.8]): OutputSession & { volume: number[] } {
  const session = {
    id,
    volume: initial,
    read: vi.fn(async () => session.volume.slice()),
    write: vi.fn(async (volume: number[]) => {
      session.volume = volume.slice()
    }),
    release: vi.fn(),
  }
  return session
}
function fixture(saved: DuckedVolume[] = []) {
  let ledger = structuredClone(saved)
  const sessions: OutputSession[] = []
  const backend = { list: vi.fn(async () => ({ sessions, complete: true })), dispose: vi.fn() }
  const journal = {
    read: vi.fn(async () => ledger),
    write: vi.fn(async (entries: DuckedVolume[]) => {
      ledger = structuredClone(entries)
    }),
  }
  const warn = vi.fn()
  const state = new DuckingState(backend, journal, warn)
  return { state, sessions, backend, journal, warn, ledger: () => ledger }
}

it('snapshots before attenuation, shares a baseline and restores exact prior levels', async () => {
  const f = fixture()
  const music = playback('music', [0.8, 0.4])
  f.sessions.push(music)
  await f.state.setActive(true)
  expect(music.volume).toEqual([0.2, 0.1])
  expect(f.journal.write.mock.invocationCallOrder[1]).toBeLessThan(
    vi.mocked(music.write).mock.invocationCallOrder[0]!,
  )
  await f.state.setActive(true)
  await f.state.reconcile()
  expect(music.write).toHaveBeenCalledOnce()
  await f.state.setActive(false)
  expect(music.volume).toEqual([0.8, 0.4])
  expect(f.ledger()).toEqual([])
  expect(f.state.needsReconcile).toBe(false)
})

it('ducks newly opened streams and never restores a closed stream onto its replacement', async () => {
  const f = fixture()
  const old = playback('old-session')
  f.sessions.push(old)
  await f.state.setActive(true)
  const next = playback('new-session', [0.6])
  f.sessions.splice(0, 1, next)
  await f.state.reconcile()
  expect(next.volume).toEqual([0.15])
  await f.state.setActive(false)
  expect(next.volume).toEqual([0.6])
  expect(old.write).toHaveBeenCalledOnce()
})

it('preserves user volume changes, silence, and Ari-owned sessions', async () => {
  const f = fixture()
  const music = playback('music')
  const silence = playback('silence', [0])
  const own = Object.assign(playback('Ari'), { excluded: true })
  f.sessions.push(music, silence, own)
  await f.state.setActive(true)
  music.volume = [0.45]
  await f.state.reconcile()
  await f.state.setActive(false)
  expect(music.volume).toEqual([0.45])
  expect(own.write).not.toHaveBeenCalled()
  expect(silence.write).not.toHaveBeenCalled()
})

it('restores a session that becomes excluded during capture', async () => {
  const f = fixture()
  const own = Object.assign(playback('new-Ari-process'), { excluded: false })
  f.sessions.push(own)
  await f.state.setActive(true)
  own.excluded = true
  await f.state.reconcile()
  expect(own.volume).toEqual([0.8])
})

it('recovers journaled writes after helper failure without overwriting intervening user changes', async () => {
  const saved = [
    { id: 'music', original: [0.8], applied: [0.2] },
    { id: 'user', original: [0.8], applied: [0.2] },
  ]
  const f = fixture(saved)
  const music = playback('music', [0.2])
  const user = playback('user', [0.5])
  f.sessions.push(music, user)
  await f.state.reconcile()
  expect(music.volume).toEqual([0.8])
  expect(user.volume).toEqual([0.5])
  expect(f.ledger()).toEqual([])
})

it('does not touch audio if saving its restoration baseline fails', async () => {
  const f = fixture()
  await f.state.reconcile()
  const music = playback('music')
  f.sessions.push(music)
  f.journal.write.mockRejectedValueOnce(new Error('Disk unavailable'))
  await f.state.setActive(true)
  expect(music.write).not.toHaveBeenCalled()
  expect(music.volume).toEqual([0.8])
  expect(f.warn).toHaveBeenCalled()
})

it('cancels activation that is still saving its baseline', async () => {
  const f = fixture()
  const music = playback('music')
  f.sessions.push(music)
  await f.state.reconcile()
  let saved!: () => void
  f.journal.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        saved = resolve
      }),
  )
  const activation = f.state.setActive(true)
  await vi.waitFor(() => expect(saved).toBeTypeOf('function'))
  const stop = f.state.setActive(false)
  saved()
  await Promise.all([activation, stop])
  expect(music.volume).toEqual([0.8])
  expect(music.write).not.toHaveBeenCalled()
})

it('retains a baseline on incomplete enumeration and retries failed restoration', async () => {
  const f = fixture()
  const music = playback('music')
  f.sessions.push(music)
  await f.state.setActive(true)
  f.backend.list.mockResolvedValueOnce({ sessions: [], complete: false })
  await f.state.setActive(false)
  expect(f.ledger()).toHaveLength(1)
  vi.mocked(music.write).mockRejectedValueOnce(new Error('Device reconnecting'))
  await f.state.reconcile()
  expect(f.ledger()).toHaveLength(1)
  await f.state.close()
  expect(music.volume).toEqual([0.8])
  expect(f.backend.dispose).toHaveBeenCalledOnce()
})

it('coalesces slow polls so restoration is not queued behind elapsed recording time', async () => {
  const f = fixture()
  const music = playback('music')
  f.sessions.push(music)
  await f.state.setActive(true)
  let available!: () => void
  f.backend.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        available = () => resolve({ sessions: f.sessions, complete: true })
      }),
  )
  const pending = f.state.reconcile()
  for (let i = 0; i < 100; i++) void f.state.reconcile()
  const stop = f.state.setActive(false)
  available()
  const count = f.backend.list.mock.calls.length
  await Promise.all([pending, stop])
  expect(f.backend.list.mock.calls.length - count).toBeLessThanOrEqual(1)
  expect(music.volume).toEqual([0.8])
})

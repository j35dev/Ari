import { describe, expect, it, vi } from 'vitest'
import { FocusMusicBackend, parseCliampSearch, parseCliampStatus } from './focus-music'
import type { DaemonHandle, FocusMusicRunner } from './focus-music'

/**
 * Backend with a fake process table: `daemonUp` flips the instance probe,
 * so tests distinguish Adopt (already running) from Spawn (Ari starts it).
 */
function spawningBackend(options: {
  binary?: string | null
  daemonUp?: boolean
  spawnBringsUp?: boolean
  help?: string
}) {
  let daemonUp = options.daemonUp ?? false
  const kill = vi.fn(() => true)
  const spawnDaemon = vi.fn((_binary: string, _args: string[]): DaemonHandle => {
    if (options.spawnBringsUp ?? true) daemonUp = true
    return { exitCode: null, kill }
  })
  const run = vi.fn((args: string[]) => {
    if (args[0] === '--help') return Promise.resolve({ stdout: options.help ?? 'search volume' })
    if (args[0] === 'status') {
      return daemonUp
        ? Promise.resolve({
            stdout: JSON.stringify({ playing: true, title: 'Grind', artist: 'DJ' }),
          })
        : Promise.reject(new Error('no daemon'))
    }
    return Promise.resolve({ stdout: '' })
  })
  const runner: FocusMusicRunner = {
    locateBinary: () =>
      Promise.resolve(options.binary === undefined ? '/bin/cliamp' : options.binary),
    run,
  }
  const backend = new FocusMusicBackend({
    runner,
    spawnDaemon,
    delay: () => Promise.resolve(),
  })
  return { backend, run, spawnDaemon, kill }
}

describe('parseCliampStatus', () => {
  it('reads flat status JSON', () => {
    expect(
      parseCliampStatus(
        JSON.stringify({ playing: true, title: 'Lo-fi', artist: 'DJ', volume: 42 }),
      ),
    ).toEqual({
      playing: true,
      track: { id: 'Lo-fi', title: 'Lo-fi', artist: 'DJ' },
      volume: 42,
    })
  })

  it('reads nested track objects and clamps volume', () => {
    expect(
      parseCliampStatus(
        JSON.stringify({ state: 'playing', track: { id: 't1', title: 'Grind', volume: 140 } }),
      ),
    ).toEqual({ playing: true, track: { id: 't1', title: 'Grind', artist: '' }, volume: null })
  })

  it('returns null for garbage', () => {
    expect(parseCliampStatus('not json')).toBeNull()
    expect(parseCliampStatus('{}')).toBeNull()
  })
})

describe('parseCliampSearch', () => {
  it('accepts arrays and {tracks} envelopes while dropping bad rows', () => {
    const stdout = JSON.stringify({ tracks: [{ id: 'a', title: 'A' }, { nope: 1 }] })
    expect(parseCliampSearch(stdout)).toEqual([{ id: 'a', title: 'A', artist: '' }])
    expect(parseCliampSearch('oops')).toBeNull()
  })
})

describe('FocusMusicBackend', () => {
  it('reports unavailable with a helpful detail when no binary exists', async () => {
    const { backend, spawnDaemon } = spawningBackend({ binary: null })
    const state = await backend.status()
    expect(state.available).toBe(false)
    expect(state.track).toBeNull()
    expect(state.detail).toMatch(/not installed/)
    expect(spawnDaemon).not.toHaveBeenCalled()
    await expect(backend.control(['play'])).resolves.toEqual({
      ok: false,
      error: 'Cliamp is not installed.',
    })
  })

  it('adopts an already-running instance without spawning; close never kills it', async () => {
    const { backend, spawnDaemon, kill } = spawningBackend({ daemonUp: true })
    const state = await backend.status()
    expect(state).toMatchObject({ available: true, playing: true })
    expect(state.track?.title).toBe('Grind')
    expect(spawnDaemon).not.toHaveBeenCalled()
    await expect(backend.control(['pause'])).resolves.toEqual({ ok: true })
    backend.close()
    expect(kill).not.toHaveBeenCalled()
    expect(spawnDaemon).not.toHaveBeenCalled()
  })

  it('spawns an owned daemon when none answers; close stops exactly it', async () => {
    const { backend, run, spawnDaemon, kill } = spawningBackend({})
    const state = await backend.status()
    expect(state).toMatchObject({ available: true, playing: true })
    expect(spawnDaemon).toHaveBeenCalledWith('/bin/cliamp', ['--daemon'])
    await expect(backend.control(['pause'])).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['pause'], expect.any(Number))
    backend.close()
    expect(kill).toHaveBeenCalledTimes(1)
    backend.close()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('starts the daemon on demand for control commands', async () => {
    const { backend, run, spawnDaemon } = spawningBackend({})
    await expect(backend.control(['play'])).resolves.toEqual({ ok: true })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(['play'], expect.any(Number))
  })

  it('cleans up a spawned daemon that never answers and backs off respawns', async () => {
    const { backend, spawnDaemon, kill } = spawningBackend({ spawnBringsUp: false })
    const state = await backend.status()
    expect(state).toMatchObject({ available: false })
    expect(state.detail).toMatch(/did not start/)
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledTimes(1)
    // The cooldown suppresses an immediate respawn loop.
    await expect(backend.status()).resolves.toMatchObject({ available: false })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  })

  it('refuses search/volume gracefully when the backend lacks them', async () => {
    const { backend } = spawningBackend({ daemonUp: true, help: 'play pause' })
    await expect(backend.search('lofi')).resolves.toMatchObject({ tracks: [] })
    await expect(backend.setVolume(50)).resolves.toMatchObject({ ok: false })
  })
})

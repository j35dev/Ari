import { describe, expect, it, vi } from 'vitest'
import { FocusMusicBackend, parseCliampSearch, parseCliampStatus } from './focus-music'
import type { FocusMusicRunner } from './focus-music'

function runner(overrides: Partial<FocusMusicRunner> = {}): FocusMusicRunner {
  return {
    locateBinary: () => Promise.resolve('/bin/cliamp'),
    run: vi.fn(() => Promise.resolve({ stdout: '{}' })),
    ...overrides,
  }
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
    const backend = new FocusMusicBackend({
      locateBinary: () => Promise.resolve(null),
      run: vi.fn(() => Promise.reject(new Error('unreachable'))),
    })
    const state = await backend.status()
    expect(state.available).toBe(false)
    expect(state.track).toBeNull()
    expect(state.detail).toMatch(/not installed/)
    await expect(backend.control(['play'])).resolves.toEqual({
      ok: false,
      error: 'Cliamp is not installed.',
    })
  })

  it('degrades to unreachable instead of throwing when the backend errors', async () => {
    const backend = new FocusMusicBackend(
      runner({ run: vi.fn(() => Promise.reject(new Error('boom'))) }),
    )
    const state = await backend.status()
    expect(state).toMatchObject({ available: false, playing: false, track: null })
    await expect(backend.control(['next'])).resolves.toMatchObject({ ok: false })
  })

  it('reports live status and forwards transport commands', async () => {
    const run = vi.fn((args: string[]) => {
      if (args[0] === '--help') return Promise.resolve({ stdout: 'search volume' })
      if (args[0] === 'status')
        return Promise.resolve({
          stdout: JSON.stringify({ playing: true, title: 'Grind', artist: 'DJ' }),
        })
      return Promise.resolve({ stdout: '' })
    })
    const backend = new FocusMusicBackend(runner({ run }))
    const state = await backend.status()
    expect(state).toMatchObject({
      available: true,
      playing: true,
      supportsSearch: true,
      supportsVolume: true,
    })
    expect(state.track?.title).toBe('Grind')
    await expect(backend.control(['pause'])).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['pause'], expect.any(Number))
  })

  it('refuses search/volume gracefully when the backend lacks them', async () => {
    const run = vi.fn((args: string[]) => {
      if (args[0] === '--help') return Promise.resolve({ stdout: 'play pause' })
      return Promise.resolve({ stdout: '{}' })
    })
    const backend = new FocusMusicBackend(runner({ run }))
    await expect(backend.search('lofi')).resolves.toMatchObject({ tracks: [] })
    await expect(backend.setVolume(50)).resolves.toMatchObject({ ok: false })
  })
})

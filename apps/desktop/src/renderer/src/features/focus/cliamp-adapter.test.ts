import { describe, expect, it, vi } from 'vitest'
import { CliampAdapter } from './cliamp-adapter'
import { DISCONNECTED_MUSIC } from './music-types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

describe('CliampAdapter', () => {
  it('passes status through and degrades to disconnected on IPC failure', async () => {
    const live = {
      available: true,
      playing: true,
      track: { id: 't', title: 'Grind', artist: 'DJ', station: '' },
      volume: 60,
      positionMs: 10_000,
      durationMs: 90_000,
      supportsSearch: true,
      supportsVolume: true,
      shuffle: false,
      detail: '',
    }
    invoke.mockResolvedValueOnce(live)
    await expect(new CliampAdapter().getState()).resolves.toEqual(live)

    invoke.mockRejectedValueOnce(new Error('ipc down'))
    await expect(new CliampAdapter().getState()).resolves.toEqual(DISCONNECTED_MUSIC)
  })

  it('delegates transport calls and maps throws to unreachable errors', async () => {
    invoke.mockResolvedValueOnce({ ok: true })
    await expect(new CliampAdapter().play('t1')).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('focus.music.play', { trackId: 't1' })

    invoke.mockResolvedValueOnce({ ok: true })
    await expect(new CliampAdapter().pause()).resolves.toEqual({ ok: true })

    invoke.mockRejectedValueOnce(new Error('ipc down'))
    await expect(new CliampAdapter().next()).resolves.toEqual({
      ok: false,
      error: 'Music backend is unreachable.',
    })

    invoke.mockResolvedValueOnce({ tracks: [] })
    await expect(new CliampAdapter().search('lofi')).resolves.toEqual({ tracks: [] })
    expect(invoke).toHaveBeenCalledWith('focus.music.search', { query: 'lofi' })

    invoke.mockResolvedValueOnce({ tracks: [] })
    await expect(new CliampAdapter().browse()).resolves.toEqual({ tracks: [] })
    expect(invoke).toHaveBeenCalledWith('focus.music.browse')

    invoke.mockRejectedValueOnce(new Error('ipc down'))
    await expect(new CliampAdapter().setVolume(40)).resolves.toEqual({
      ok: false,
      error: 'Music backend is unreachable.',
    })

    invoke.mockResolvedValueOnce({ ok: true })
    await expect(new CliampAdapter().seek(72_000)).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenCalledWith('focus.music.seek', { positionMs: 72_000 })
  })
})

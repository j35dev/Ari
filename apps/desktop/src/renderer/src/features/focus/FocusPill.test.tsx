import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AriPlaylist,
  FocusMusicState,
  FocusTrack,
  FocusUrlResolve,
  MusicService,
} from './music-types'
import { FocusPill } from './FocusPill'
import { FOCUS_TIMER_STORAGE_KEY } from './focus-timer'

const TRACK: FocusTrack = {
  id: 'https://www.youtube.com/watch?v=abc',
  title: 'Nightcall',
  artist: 'Kavinsky',
  station: '',
  sourceUrl: 'https://www.youtube.com/watch?v=abc',
}

function idleState(): FocusMusicState {
  return {
    available: false,
    playing: false,
    track: null,
    volume: null,
    positionMs: null,
    durationMs: null,
    supportsSearch: false,
    supportsVolume: false,
    shuffle: false,
    detail: 'Music is unavailable right now.',
  }
}

function playingState(): FocusMusicState {
  return {
    available: true,
    playing: true,
    track: { id: 't1', title: 'Grind', artist: 'DJ', station: 'Jazz FM' },
    volume: 60,
    positionMs: 72_000,
    durationMs: 240_000,
    supportsSearch: true,
    supportsVolume: true,
    shuffle: false,
    detail: '',
  }
}

/** Controllable MusicService; records calls and pushes state to subscribers. */
class StubService implements MusicService {
  state: FocusMusicState
  readonly calls: string[] = []
  playlists: AriPlaylist[] = []
  resolveResult: FocusUrlResolve = { kind: 'invalid', error: 'Paste a YouTube link.' }
  readonly listeners = new Set<(state: FocusMusicState) => void>()
  subscribe: ((listener: (state: FocusMusicState) => void) => () => void) | undefined

  constructor(state: FocusMusicState, withSubscribe = true) {
    this.state = state
    if (withSubscribe) {
      this.subscribe = (listener) => {
        this.listeners.add(listener)
        listener(this.state)
        return () => {
          this.listeners.delete(listener)
        }
      }
    }
  }

  set(patch: Partial<FocusMusicState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  async getState(): Promise<FocusMusicState> {
    this.calls.push('getState')
    return this.state
  }

  async play(trackId?: string): Promise<{ ok: boolean }> {
    this.calls.push(`play:${trackId ?? ''}`)
    this.set({ playing: true })
    return { ok: true }
  }

  async pause(): Promise<{ ok: boolean }> {
    this.calls.push('pause')
    this.set({ playing: false })
    return { ok: true }
  }

  async next(): Promise<{ ok: boolean }> {
    this.calls.push('next')
    return { ok: true }
  }

  async previous(): Promise<{ ok: boolean }> {
    this.calls.push('previous')
    return { ok: true }
  }

  async search(): Promise<{ tracks: FocusTrack[] }> {
    this.calls.push('search')
    return { tracks: [] }
  }

  async browse(): Promise<{ tracks: FocusTrack[] }> {
    this.calls.push('browse')
    return { tracks: [] }
  }

  async setVolume(volume: number): Promise<{ ok: boolean }> {
    this.calls.push(`volume:${volume}`)
    this.set({ volume })
    return { ok: true }
  }

  async seek(positionMs: number): Promise<{ ok: boolean }> {
    this.calls.push(`seek:${positionMs}`)
    this.set({ positionMs })
    return { ok: true }
  }

  async shuffle(enabled: boolean): Promise<{ ok: boolean }> {
    this.calls.push(`shuffle:${enabled}`)
    this.set({ shuffle: enabled })
    return { ok: true }
  }

  async queue(trackId: string): Promise<{ ok: boolean }> {
    this.calls.push(`queue:${trackId}`)
    return { ok: true }
  }

  async resolveUrl(): Promise<FocusUrlResolve> {
    this.calls.push('resolveUrl')
    return this.resolveResult
  }

  async listPlaylists(): Promise<{ playlists: AriPlaylist[] }> {
    return { playlists: this.playlists }
  }

  async createPlaylist(
    name: string,
    tracks: FocusTrack[] = [],
  ): Promise<{ playlist: AriPlaylist | null }> {
    const playlist = { id: `fpl_${this.playlists.length + 1}`, name, tracks }
    this.playlists = [...this.playlists, playlist]
    return { playlist }
  }

  async renamePlaylist(id: string, name: string): Promise<{ playlist: AriPlaylist | null }> {
    this.playlists = this.playlists.map((row) => (row.id === id ? { ...row, name } : row))
    return { playlist: this.playlists.find((row) => row.id === id) ?? null }
  }

  async removePlaylist(id: string): Promise<{ ok: boolean }> {
    this.playlists = this.playlists.filter((row) => row.id !== id)
    return { ok: true }
  }

  async updatePlaylist(
    id: string,
    tracks: FocusTrack[],
  ): Promise<{ playlist: AriPlaylist | null }> {
    this.playlists = this.playlists.map((row) => (row.id === id ? { ...row, tracks } : row))
    return { playlist: this.playlists.find((row) => row.id === id) ?? null }
  }

  async playPlaylist(id: string, shuffle?: boolean): Promise<{ ok: boolean }> {
    this.calls.push(`playPlaylist:${id}:${shuffle ?? ''}`)
    const playlist = this.playlists.find((row) => row.id === id)
    const first = playlist?.tracks[0]
    if (first) this.set({ playing: true, track: first, shuffle: shuffle ?? false })
    return { ok: true }
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('FocusPill', () => {
  it('rests in a subtle idle state and opens the popover with timer tooling', async () => {
    render(<FocusPill service={new StubService(idleState())} />)
    await settle()
    const pill = screen.getByRole('button', { name: 'Focus: music and timer' })
    expect(pill).toHaveTextContent('Focus')

    fireEvent.click(pill)
    await settle()
    expect(screen.getByRole('dialog', { name: 'Focus' })).toBeInTheDocument()
    expect(screen.getByText('Your music')).toBeInTheDocument()
    expect(screen.getByText('Add from YouTube')).toBeInTheDocument()
    expect(screen.getByText('Saved playlists')).toBeInTheDocument()
    expect(screen.getByText('No playlists yet.')).toBeInTheDocument()
    expect(screen.getByText('Music unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.getByLabelText('Timer name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('shows the equalizer while music plays and offers transport controls', async () => {
    const service = new StubService(playingState())
    render(<FocusPill service={service} />)
    await settle()
    const pill = screen.getByRole('button', { name: /Music playing: Grind by DJ/ })
    fireEvent.click(pill)
    await settle()
    expect(screen.getByText('Grind')).toBeInTheDocument()
    expect(screen.getByText('DJ · Jazz FM')).toBeInTheDocument()
    const seek = screen.getByRole('slider', { name: /Playback position 1:12 of 4:00/ })
    fireEvent.change(seek, { target: { value: 90_000 } })
    await waitFor(() => {
      expect(service.calls).toContain('seek:90000')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => {
      expect(service.calls).toContain('pause')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next track' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous track' }))
    await waitFor(() => {
      expect(service.calls).toContain('next')
      expect(service.calls).toContain('previous')
    })
  })

  it('combines an active timer with the music indicator and truncates long names', async () => {
    localStorage.setItem(
      FOCUS_TIMER_STORAGE_KEY,
      JSON.stringify({
        status: 'running',
        name: 'a-very-long-focus-session-name',
        durationMs: 40 * 60_000,
        endsAt: Date.now() + 38 * 60_000,
        remainingMs: 38 * 60_000,
      }),
    )
    render(<FocusPill service={new StubService(playingState())} />)
    await settle()
    const pill = screen.getByRole('button', { name: /Focus timer a-very-long-focus-session-name/ })
    expect(pill).toHaveTextContent('a-very-long-focus… · 38m')
  })

  it('shows no station chips without a radio backend', async () => {
    render(<FocusPill service={new StubService({ ...playingState(), playing: false })} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Chiptunes' })).not.toBeInTheDocument()
  })

  it('lists saved playlists and plays one', async () => {
    const service = new StubService({ ...playingState(), playing: false })
    service.playlists = [{ id: 'fpl_1', name: 'Coding Bangers', tracks: [TRACK] }]
    render(<FocusPill service={service} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await waitFor(() => {
      expect(screen.getByText('Coding Bangers')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play Coding Bangers' }))
    await waitFor(() => {
      expect(service.calls).toContain('playPlaylist:fpl_1:')
    })
  })

  it('expands, renames, edits, and deletes a saved playlist', async () => {
    const service = new StubService({ ...playingState(), playing: false })
    service.playlists = [
      { id: 'fpl_1', name: 'Coding Bangers', tracks: [{ ...TRACK, artist: 'Kavinsky' }] },
    ]
    render(<FocusPill service={service} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await waitFor(() => expect(screen.getByText('Coding Bangers')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Expand Coding Bangers' }))
    expect(screen.getByText('Nightcall')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Nightcall from Coding Bangers' }))
    await waitFor(() => {
      expect(service.playlists[0]?.tracks).toHaveLength(0)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Rename Coding Bangers' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Coding Bangers' }), {
      target: { value: 'Deep work' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(screen.getByText('Deep work')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Delete Deep work' }))
    await waitFor(() => {
      expect(service.playlists).toHaveLength(0)
      expect(screen.queryByText('Deep work')).not.toBeInTheDocument()
    })
  })

  it('creates a named playlist from the add field', async () => {
    const service = new StubService({ ...playingState(), playing: false })
    render(<FocusPill service={service} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'New playlist' }))
    fireEvent.change(screen.getByLabelText('New playlist name'), {
      target: { value: 'Coding Bangers' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Play Coding Bangers' })).toBeInTheDocument()
    })
  })

  it('adds a resolved song to the explicitly selected playlist', async () => {
    const service = new StubService({ ...playingState(), playing: false })
    service.resolveResult = { kind: 'track', track: TRACK }
    service.playlists = [{ id: 'fpl_1', name: 'Night drives', tracks: [] }]
    render(<FocusPill service={service} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    fireEvent.change(screen.getByPlaceholderText('Paste song or playlist URL…'), {
      target: { value: TRACK.id },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByLabelText('Choose playlist')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Choose playlist'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Night drives/ }))
    await waitFor(() => {
      expect(service.playlists[0]?.tracks).toEqual([TRACK])
    })
  })

  it('offers Quiet, Normal, and Room sound profiles', async () => {
    const service = new StubService(playingState())
    render(<FocusPill service={service} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Music playing: Grind by DJ/ }))
    await settle()
    expect(screen.getByRole('button', { name: 'Quiet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Normal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Room' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Quiet' }))
    await waitFor(() => {
      expect(service.calls).toContain('volume:33')
    })
  })

  it('surfaces a resolve error without naming the backend', async () => {
    const service = new StubService({ ...playingState(), playing: false })
    service.resolveResult = { kind: 'invalid', error: 'Music is unavailable right now.' }
    render(<FocusPill service={service} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    fireEvent.change(screen.getByPlaceholderText('Paste song or playlist URL…'), {
      target: { value: 'https://www.youtube.com/watch?v=abc' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await settle()
    expect(screen.getByText('Music is unavailable right now.')).toBeInTheDocument()
  })

  it('starts a timer from the popover form', async () => {
    render(<FocusPill service={new StubService(idleState())} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    fireEvent.change(screen.getByLabelText('Timer name'), { target: { value: 'Grind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await settle()
    expect(screen.getByRole('button', { name: /Focus timer Grind/ })).toBeInTheDocument()
  })

  it('polls only while the popover is open or music is playing', async () => {
    vi.useFakeTimers()
    try {
      const service = new StubService(idleState(), false)
      render(<FocusPill service={service} />)
      await settle()
      const polls = () => service.calls.filter((call) => call === 'getState').length
      const base = polls()
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      expect(polls()).toBe(base)
      fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
      await settle()
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      expect(polls()).toBeGreaterThan(base + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

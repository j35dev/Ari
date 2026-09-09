import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FocusMusicState } from '@ari/contracts/rpc'
import { FocusPill } from './FocusPill'
import { FOCUS_TIMER_STORAGE_KEY } from './focus-timer'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

const idle: FocusMusicState = {
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

function playing(): FocusMusicState {
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

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset().mockImplementation(async (method: string) => {
    if (method === 'focus.music.status') return idle
    if (method === 'focus.music.search') return { tracks: [] }
    if (method === 'focus.music.browse') return { tracks: [] }
    if (method === 'focus.playlists.list') return { playlists: [] }
    return { ok: true }
  })
})

describe('FocusPill', () => {
  it('rests in a subtle idle state and opens the popover with timer tooling', async () => {
    render(<FocusPill />)
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
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') return playing()
      if (method === 'focus.music.search') return { tracks: [] }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    const pill = screen.getByRole('button', { name: /Music playing: Grind by DJ/ })
    fireEvent.click(pill)
    await settle()
    expect(screen.getByText('Grind')).toBeInTheDocument()
    expect(screen.getByText('DJ · Jazz FM')).toBeInTheDocument()
    const seek = screen.getByRole('slider', { name: /Playback position 1:12 of 4:00/ })
    fireEvent.change(seek, { target: { value: 90_000 } })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('focus.music.seek', { positionMs: 90_000 })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await settle()
    expect(invoke).toHaveBeenCalledWith('focus.music.pause')
  })

  it('combines an active timer with the music indicator and truncates long names', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') return playing()
      return { ok: true }
    })
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
    render(<FocusPill />)
    await settle()
    const pill = screen.getByRole('button', { name: /Focus timer a-very-long-focus-session-name/ })
    expect(pill).toHaveTextContent('a-very-long-focus… · 38m')
  })

  it('offers station chips from browse and plays the selected one', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') {
        return { ...playing(), playing: false, track: null }
      }
      if (method === 'focus.music.browse') {
        return {
          tracks: [
            { id: 'lofi', title: 'Lofi', artist: '', station: 'Lofi' },
            { id: 'chips', title: 'Chiptunes', artist: '', station: 'Chiptunes' },
          ],
        }
      }
      if (method === 'focus.music.search') return { tracks: [] }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Chiptunes' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Chiptunes' }))
    await settle()
    expect(invoke).toHaveBeenCalledWith('focus.music.play', { trackId: 'chips' })
  })

  it('lists saved playlists and plays one', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') return { ...playing(), playing: false, track: null }
      if (method === 'focus.playlists.list') {
        return {
          playlists: [
            {
              id: 'fpl_1',
              name: 'Coding Bangers',
              tracks: [{ id: 'https://www.youtube.com/watch?v=abc', title: 'Nightcall' }],
            },
          ],
        }
      }
      if (method === 'focus.music.browse') return { tracks: [] }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await waitFor(() => {
      expect(screen.getByText('Coding Bangers')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play Coding Bangers' }))
    await settle()
    expect(invoke).toHaveBeenCalledWith('focus.playlists.play', { id: 'fpl_1', shuffle: undefined })
  })

  it('expands, renames, edits, and deletes a saved playlist', async () => {
    let playlist = {
      id: 'fpl_1',
      name: 'Coding Bangers',
      tracks: [
        {
          id: 'https://www.youtube.com/watch?v=abc',
          title: 'Nightcall',
          artist: 'Kavinsky',
          station: '',
        },
      ],
    }
    invoke.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'focus.music.status') return { ...playing(), playing: false, track: null }
      if (method === 'focus.music.browse') return { tracks: [] }
      if (method === 'focus.playlists.list') return { playlists: [playlist] }
      if (method === 'focus.playlists.rename') {
        playlist = { ...playlist, name: String(params?.['name']) }
        return { playlist }
      }
      if (method === 'focus.playlists.update') {
        playlist = { ...playlist, tracks: params?.['tracks'] as typeof playlist.tracks }
        return { playlist }
      }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await waitFor(() => expect(screen.getByText('Coding Bangers')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Expand Coding Bangers' }))
    expect(screen.getByText('Nightcall')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Nightcall from Coding Bangers' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('focus.playlists.update', {
        id: 'fpl_1',
        tracks: [],
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Rename Coding Bangers' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Coding Bangers' }), {
      target: { value: 'Deep work' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(screen.getByText('Deep work')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Delete Deep work' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('focus.playlists.remove', { id: 'fpl_1' })
      expect(screen.queryByText('Deep work')).not.toBeInTheDocument()
    })
  })

  it('creates a named playlist from the add field', async () => {
    const saved: { id: string; name: string; tracks: unknown[] }[] = []
    invoke.mockImplementation(
      async (method: string, params?: { name?: string; tracks?: unknown[] }) => {
        if (method === 'focus.music.status') return { ...playing(), playing: false, track: null }
        if (method === 'focus.playlists.create') {
          const playlist = { id: 'fpl_new', name: params?.name ?? '', tracks: params?.tracks ?? [] }
          saved.push(playlist)
          return { playlist }
        }
        if (method === 'focus.playlists.list') return { playlists: saved }
        if (method === 'focus.music.browse') return { tracks: [] }
        return { ok: true }
      },
    )
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'New playlist' }))
    fireEvent.change(screen.getByLabelText('New playlist name'), {
      target: { value: 'Coding Bangers' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('focus.playlists.create', {
        name: 'Coding Bangers',
        tracks: undefined,
      })
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Play Coding Bangers' })).toBeInTheDocument()
    })
  })

  it('adds a resolved song to the explicitly selected playlist', async () => {
    const track = {
      id: 'https://www.youtube.com/watch?v=abc',
      title: 'Nightcall',
      artist: 'Kavinsky',
      station: '',
    }
    const playlist = { id: 'fpl_1', name: 'Night drives', tracks: [] as (typeof track)[] }
    invoke.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'focus.music.status') return { ...playing(), playing: false, track: null }
      if (method === 'focus.music.browse') return { tracks: [] }
      if (method === 'focus.playlists.list') return { playlists: [playlist] }
      if (method === 'focus.music.resolve') return { kind: 'track', track }
      if (method === 'focus.playlists.update') {
        return { playlist: { ...playlist, tracks: params?.['tracks'] } }
      }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    fireEvent.change(screen.getByPlaceholderText('Paste song or playlist URL…'), {
      target: { value: track.id },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByLabelText('Choose playlist')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Choose playlist'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Night drives/ }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('focus.playlists.update', {
        id: 'fpl_1',
        tracks: [track],
      })
    })
  })

  it('offers Quiet, Normal, and Room sound profiles', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') return playing()
      if (method === 'focus.playlists.list') return { playlists: [] }
      if (method === 'focus.music.browse') return { tracks: [] }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Music playing: Grind by DJ/ }))
    await settle()
    expect(screen.getByRole('button', { name: 'Quiet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Normal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Room' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Quiet' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('focus.music.volume', { volume: 33 })
    })
  })

  it('surfaces a native resolve error without naming the backend', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') {
        return { ...playing(), playing: false, track: null }
      }
      if (method === 'focus.music.resolve') {
        return { kind: 'invalid', error: 'Music is unavailable right now.' }
      }
      if (method === 'focus.music.browse') return { tracks: [] }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    fireEvent.change(screen.getByPlaceholderText('Paste song or playlist URL…'), {
      target: { value: 'https://www.youtube.com/watch?v=abc' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await settle()
    expect(screen.getByText('Music is unavailable right now.')).toBeInTheDocument()
    expect(screen.queryByText(/cliamp/i)).not.toBeInTheDocument()
  })

  it('starts a timer from the popover form', async () => {
    render(<FocusPill />)
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
      render(<FocusPill />)
      await settle()
      const statusCalls = () =>
        invoke.mock.calls.filter(([method]) => method === 'focus.music.status').length
      const base = statusCalls()
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      expect(statusCalls()).toBe(base)
      fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
      await settle()
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      expect(statusCalls()).toBeGreaterThan(base + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

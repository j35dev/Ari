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
  supportsSearch: false,
  supportsVolume: false,
  detail: 'Music is unavailable right now.',
}

function playing(): FocusMusicState {
  return {
    available: true,
    playing: true,
    track: { id: 't1', title: 'Grind', artist: 'DJ', station: 'Jazz FM' },
    volume: 60,
    supportsSearch: true,
    supportsVolume: true,
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

  it('surfaces a native search error without naming the backend', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'focus.music.status') {
        return { ...playing(), playing: false, track: null }
      }
      if (method === 'focus.music.search') {
        return { tracks: [], error: 'Music is unavailable right now.' }
      }
      if (method === 'focus.music.browse') return { tracks: [] }
      return { ok: true }
    })
    render(<FocusPill />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Focus: music and timer' }))
    await settle()
    fireEvent.change(screen.getByPlaceholderText('Search stations…'), { target: { value: 'lofi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ListMusic,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Shuffle,
  SkipBack,
  SkipForward,
  Timer,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import { AriMusicAdapter } from './music-adapter'
import { DISCONNECTED_MUSIC } from './music-types'
import type { AriPlaylist, FocusTrack, FocusUrlResolve, MusicService } from './music-types'
import {
  FOCUS_TIMER_PRESETS_MIN,
  formatTimerRemaining,
  truncateTimerName,
  useFocusTimer,
} from './focus-timer'
import type { FocusTimerHandle } from './focus-timer'
import './focus.css'

const MUSIC_POLL_MS = 15_000
const VOLUME_COMMIT_MS = 250
const SEEK_COMMIT_MS = 200

function formatPlaybackTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

const SOUND_PROFILES = [
  { id: 'quiet', label: 'Quiet', slider: 33 },
  { id: 'normal', label: 'Normal', slider: 50 },
  { id: 'room', label: 'Room', slider: 67 },
] as const

/** Subtle animated equalizer shown only while music is actually playing. */
function EqBars() {
  return (
    <span className="ari-focus-eq text-accent" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

const iconButton =
  'flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40'

const fieldInput =
  'h-7 rounded-md border border-border bg-glass-input px-2 text-xs text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none'

/**
 * Compact header pill combining music state and an optional focus timer.
 * Music and timer stay independent services; the pill only renders their
 * combined state. The timer lives in the always-mounted header, so it keeps
 * counting while the popover is closed, across rerenders, navigation, and
 * restarts (absolute `endsAt` persisted to localStorage).
 */
export function FocusPill({ service }: { service?: MusicService }) {
  const adapter = useMemo(() => service ?? new AriMusicAdapter(), [service])
  const [music, setMusic] = useState(DISCONNECTED_MUSIC)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useFocusTimer()
  const timerActive = timer.status === 'running' || timer.status === 'paused'

  const refreshMusic = useCallback(async () => {
    setMusic(await adapter.getState())
  }, [adapter])

  // One snapshot on mount, then live polling only while the popover is
  // open or music is actually playing — never a background poll loop.
  useEffect(() => {
    void refreshMusic()
  }, [refreshMusic])

  // Push updates when the service supports them; otherwise poll getState
  // while the popover is open or music is playing — never a background loop.
  useEffect(() => {
    if (typeof adapter.subscribe === 'function') {
      return adapter.subscribe((next) => setMusic(next))
    }
    if (!open && !music.playing) return
    const id = window.setInterval(() => {
      void refreshMusic()
    }, MUSIC_POLL_MS)
    return () => window.clearInterval(id)
  }, [adapter, open, music.playing, refreshMusic])

  useEffect(() => {
    if (open) {
      setNotice(null)
      void refreshMusic()
    }
  }, [open, refreshMusic])

  const runControl = useCallback(
    async (
      action: () => Promise<{ ok: boolean; error?: string }>,
      optimistic?: Partial<typeof music>,
    ) => {
      if (optimistic) setMusic((current) => ({ ...current, ...optimistic }))
      const result = await action()
      setNotice(result.ok ? null : (result.error ?? 'Music backend did not respond.'))
      void refreshMusic()
    },
    [refreshMusic],
  )

  const pillLabel = timerActive
    ? `Focus timer ${timer.name}, ${formatTimerRemaining(timer.remainingMs)} remaining${timer.status === 'paused' ? ', paused' : ''}${music.playing ? ', music playing' : ''}`
    : music.playing
      ? `Music playing${music.track ? `: ${music.track.title}${music.track.artist ? ` by ${music.track.artist}` : ''}` : ''}`
      : 'Focus: music and timer'

  return (
    <div className="mr-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={pillLabel}
          className="flex h-6 max-w-44 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2 text-[11px] text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {timerActive ? (
            <>
              <Timer size={11} aria-hidden="true" className="shrink-0" />
              <span className="truncate font-medium tabular-nums text-fg">
                {truncateTimerName(timer.name)} · {formatTimerRemaining(timer.remainingMs)}
              </span>
              {music.playing ? <EqBars /> : null}
            </>
          ) : music.playing ? (
            <>
              <Music size={11} aria-hidden="true" className="shrink-0" />
              <EqBars />
            </>
          ) : (
            <>
              <Music size={11} aria-hidden="true" className="shrink-0" />
              <span>Focus</span>
            </>
          )}
        </Popover.Trigger>
        <Popover.Content
          align="end"
          aria-label="Focus"
          className="ari-focus-scroll w-80 max-h-[min(72vh,32rem)] max-w-[calc(100vw-24px)] overflow-y-auto"
        >
          <LibrarySection
            adapter={adapter}
            musicAvailable={music.available}
            current={music.track}
            onPlay={(id) => void runControl(() => adapter.play(id))}
            onControl={(action) => void runControl(action)}
          />
          <MusicSection
            musicAvailable={music.available}
            track={music.track}
            playing={music.playing}
            shuffled={music.shuffle}
            positionMs={music.positionMs}
            durationMs={music.durationMs}
            detail={music.detail}
            onControl={(action, optimistic) => void runControl(action, optimistic)}
            onRetry={() => void refreshMusic()}
            adapter={adapter}
          />
          {music.supportsVolume && music.volume !== null ? (
            <VolumeSection
              volume={music.volume}
              adapter={adapter}
              onDone={() => void refreshMusic()}
            />
          ) : null}
          <TimerSection timer={timer} />
          {notice ? (
            <p role="status" className="pt-2 text-[11px] text-fg-subtle">
              {notice}
            </p>
          ) : null}
        </Popover.Content>
      </Popover>
    </div>
  )
}

function MusicSection({
  musicAvailable,
  track,
  playing,
  shuffled,
  positionMs,
  durationMs,
  detail,
  onControl,
  onRetry,
  adapter,
}: {
  musicAvailable: boolean
  track: FocusTrack | null
  playing: boolean
  shuffled: boolean
  positionMs: number | null
  durationMs: number | null
  detail: string
  onControl: (
    action: () => Promise<{ ok: boolean; error?: string }>,
    optimistic?: Partial<{ playing: boolean }>,
  ) => void
  onRetry: () => void
  adapter: MusicService
}) {
  return (
    <section aria-label="Now playing" className="mt-2.5 border-t border-border pt-2.5">
      <p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
        Now playing
      </p>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-fg">
          {track ? track.title : musicAvailable ? 'Nothing playing' : 'Music unavailable'}
        </p>
        <p className="truncate text-[11px] text-fg-subtle">
          {track
            ? [track.artist, track.station].filter((part) => part.length > 0).join(' · ') ||
              'Playing now'
            : musicAvailable
              ? 'Play something to get started'
              : detail || 'Music is unavailable — the timer still works.'}
        </p>
        {!musicAvailable ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded text-[11px] text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Check again
          </button>
        ) : null}
      </div>
      {durationMs !== null && durationMs > 0 ? (
        <SeekBar
          positionMs={positionMs ?? 0}
          durationMs={durationMs}
          disabled={!musicAvailable}
          onSeek={(next) => onControl(() => adapter.seek(next))}
        />
      ) : null}
      <div className="flex items-center gap-1 pt-1.5">
        <button
          type="button"
          aria-label="Previous track"
          disabled={!musicAvailable}
          onClick={() => onControl(() => adapter.previous())}
          className={iconButton}
        >
          <SkipBack size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={!musicAvailable}
          onClick={() =>
            onControl(() => (playing ? adapter.pause() : adapter.play()), { playing: !playing })
          }
          className={iconButton}
        >
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          aria-label="Next track"
          disabled={!musicAvailable}
          onClick={() => onControl(() => adapter.next())}
          className={iconButton}
        >
          <SkipForward size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={shuffled ? 'Shuffle on' : 'Shuffle off'}
          aria-pressed={shuffled}
          disabled={!musicAvailable}
          onClick={() => onControl(() => adapter.shuffle(!shuffled))}
          className={`${iconButton} ${shuffled ? 'text-accent' : ''}`}
        >
          <Shuffle size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}

function SeekBar({
  positionMs,
  durationMs,
  disabled,
  onSeek,
}: {
  positionMs: number
  durationMs: number
  disabled: boolean
  onSeek: (positionMs: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => setDraft(null), [positionMs])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  const shown = Math.min(durationMs, draft ?? positionMs)
  return (
    <div className="pt-2" aria-label="Playback position">
      <input
        type="range"
        min={0}
        max={durationMs}
        step={1000}
        value={shown}
        disabled={disabled}
        aria-label={`Playback position ${formatPlaybackTime(shown)} of ${formatPlaybackTime(durationMs)}`}
        style={{ '--ari-focus-progress': `${(shown / durationMs) * 100}%` } as React.CSSProperties}
        onChange={(event) => {
          const next = Number(event.target.value)
          setDraft(next)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => onSeek(next), SEEK_COMMIT_MS)
        }}
        className="ari-focus-range h-3 w-full"
      />
      <div className="flex justify-between font-mono text-[9px] tabular-nums text-fg-subtle">
        <span>{formatPlaybackTime(shown)}</span>
        <span>{formatPlaybackTime(durationMs)}</span>
      </div>
    </div>
  )
}

function VolumeSection({
  volume,
  adapter,
  onDone,
}: {
  volume: number
  adapter: MusicService
  onDone: () => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const commitTimer = useRef<number | null>(null)
  useEffect(() => {
    setDraft(null)
  }, [volume])
  useEffect(
    () => () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current)
    },
    [],
  )
  const shown = draft ?? volume
  const activeProfile = SOUND_PROFILES.find((row) => row.slider === shown)?.id
  const commit = (next: number) => {
    setDraft(next)
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current)
    commitTimer.current = window.setTimeout(() => {
      void adapter.setVolume(next).then(onDone)
    }, VOLUME_COMMIT_MS)
  }
  return (
    <section aria-label="Volume" className="mt-2.5 border-t border-border pt-2.5">
      <p className="pb-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">Sound</p>
      <div className="flex flex-wrap gap-1 pb-2">
        {SOUND_PROFILES.map((row) => (
          <button
            key={row.id}
            type="button"
            aria-pressed={activeProfile === row.id}
            onClick={() => commit(row.slider)}
            className={`h-6 rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
              activeProfile === row.id
                ? 'border-accent/25 bg-accent/15 text-accent'
                : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {row.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Volume2 size={13} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <input
          type="range"
          min={0}
          max={100}
          value={shown}
          aria-label={`Volume ${shown}%`}
          style={{ '--ari-focus-progress': `${shown}%` } as React.CSSProperties}
          onChange={(event) => commit(Number(event.target.value))}
          className="ari-focus-range h-3 w-full"
        />
      </div>
    </section>
  )
}

function LibrarySection({
  adapter,
  musicAvailable,
  current,
  onPlay,
  onControl,
}: {
  adapter: MusicService
  musicAvailable: boolean
  current: FocusTrack | null
  onPlay: (trackId: string) => void
  onControl: (action: () => Promise<{ ok: boolean; error?: string }>) => void
}) {
  const [stations, setStations] = useState<FocusTrack[]>([])
  const [playlists, setPlaylists] = useState<AriPlaylist[]>([])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<FocusUrlResolve | null>(null)

  const refreshPlaylists = useCallback(() => {
    void adapter.listPlaylists().then(({ playlists: next }) => setPlaylists(next ?? []))
  }, [adapter])

  const savePlaylist = useCallback(
    (name: string, tracks?: FocusTrack[]) => {
      void adapter.createPlaylist(name, tracks).then((result) => {
        if (result.error || !result.playlist) {
          setError(result.error ?? 'Could not save playlist.')
          return
        }
        setError(null)
        const saved = result.playlist
        setPlaylists((currentPlaylists) => {
          const existing = currentPlaylists.findIndex((row) => row.id === saved.id)
          if (existing === -1) return [...currentPlaylists, saved]
          return currentPlaylists.map((row) => (row.id === saved.id ? saved : row))
        })
      })
    },
    [adapter],
  )

  const addTrack = useCallback(
    (playlistId: string, track: FocusTrack) => {
      const target = playlists.find((row) => row.id === playlistId)
      if (!target) return
      const key = track.sourceUrl || track.id
      if (target.tracks.some((row) => (row.sourceUrl || row.id) === key)) {
        setError(`“${track.title}” is already in ${target.name}.`)
        return
      }
      void adapter.updatePlaylist(playlistId, [...target.tracks, track]).then((result) => {
        if (!result.playlist) {
          setError(result.error ?? 'Could not update playlist.')
          return
        }
        setError(null)
        setPlaylists((rows) =>
          rows.map((row) => (row.id === playlistId ? (result.playlist as AriPlaylist) : row)),
        )
      })
    },
    [adapter, playlists],
  )

  const removeTrack = useCallback(
    (playlist: AriPlaylist, trackIndex: number) => {
      void adapter
        .updatePlaylist(
          playlist.id,
          playlist.tracks.filter((_, index) => index !== trackIndex),
        )
        .then((result) => {
          if (!result.playlist) {
            setError(result.error ?? 'Could not update playlist.')
            return
          }
          setError(null)
          setPlaylists((rows) =>
            rows.map((row) => (row.id === playlist.id ? (result.playlist as AriPlaylist) : row)),
          )
        })
    },
    [adapter],
  )

  const renamePlaylist = useCallback(
    (playlistId: string, name: string) => {
      void adapter.renamePlaylist(playlistId, name).then((result) => {
        if (!result.playlist) {
          setError(result.error ?? 'Could not rename playlist.')
          return
        }
        setError(null)
        setPlaylists((rows) =>
          rows.map((row) => (row.id === playlistId ? (result.playlist as AriPlaylist) : row)),
        )
      })
    },
    [adapter],
  )

  const removePlaylist = useCallback(
    (playlistId: string) => {
      void adapter.removePlaylist(playlistId).then((result) => {
        if (!result.ok) {
          setError(result.error ?? 'Could not delete playlist.')
          return
        }
        setError(null)
        setPlaylists((rows) => rows.filter((row) => row.id !== playlistId))
      })
    },
    [adapter],
  )

  useEffect(() => {
    let cancelled = false
    void adapter.browse().then(({ tracks }) => {
      if (!cancelled) setStations((tracks ?? []).slice(0, 8))
    })
    refreshPlaylists()
    return () => {
      cancelled = true
    }
  }, [adapter, refreshPlaylists])

  return (
    <section aria-label="Your music">
      <p className="flex items-center gap-1.5 pb-2 text-xs font-medium text-fg">
        <Music size={12} aria-hidden="true" className="text-fg-subtle" />
        Your music
      </p>
      <p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
        Add from YouTube
      </p>
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          const q = query.trim()
          if (!q || searching) return
          setSearching(true)
          setError(null)
          setResolved(null)
          if (!/youtu(\.be|be\.com)/i.test(q)) {
            setSearching(false)
            setError('Paste a YouTube song or playlist link.')
            return
          }
          void adapter
            .resolveUrl(q)
            .then((next) => {
              setResolved(next)
              if (next.kind === 'invalid') setError(next.error)
              if (next.kind === 'playlist') savePlaylist(next.name, next.tracks)
            })
            .finally(() => setSearching(false))
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Paste song or playlist URL…"
          aria-label="YouTube song or playlist URL"
          className={`${fieldInput} min-w-0 flex-1`}
        />
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="h-7 shrink-0 rounded-md bg-accent px-2 text-[11px] font-medium text-fg-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
        >
          Add
        </button>
      </form>
      {error ? (
        <p role="status" className="pt-1.5 text-[11px] text-fg-subtle">
          {error}
        </p>
      ) : null}
      {resolved?.kind === 'track' ? (
        <ResolvedTrack
          track={resolved.track}
          playlists={playlists}
          onPlay={() => onPlay(resolved.track.id)}
          onQueue={() => onControl(() => adapter.queue(resolved.track.id))}
          onSave={(playlistId) => addTrack(playlistId, resolved.track)}
        />
      ) : null}
      {resolved?.kind === 'playlist' ? (
        <div className="pt-1.5">
          <p className="truncate text-[11px] text-fg">
            {resolved.name} · {resolved.tracks.length} tracks
          </p>
          <div className="flex gap-1 pt-1">
            <button
              type="button"
              className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`}
              onClick={() =>
                onControl(async () => {
                  const first = resolved.tracks[0]
                  if (!first) return { ok: false, error: 'Nothing to play.' }
                  const played = await adapter.play(first.id)
                  for (const track of resolved.tracks.slice(1)) await adapter.queue(track.id)
                  return played
                })
              }
            >
              Play
            </button>
            <button
              type="button"
              className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`}
              onClick={() =>
                onControl(async () => {
                  await adapter.shuffle(true)
                  const first = resolved.tracks[0]
                  if (!first) return { ok: false, error: 'Nothing to play.' }
                  const played = await adapter.play(first.id)
                  for (const track of resolved.tracks.slice(1)) await adapter.queue(track.id)
                  return played
                })
              }
            >
              Shuffle
            </button>
          </div>
        </div>
      ) : null}
      <div className="pt-2.5" aria-label="Saved playlists">
        <p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
          Saved playlists
        </p>
        {playlists.length === 0 ? (
          <p className="text-[11px] text-fg-subtle">No playlists yet.</p>
        ) : (
          <ul>
            {playlists.map((playlist) => (
              <PlaylistRow
                key={playlist.id}
                playlist={playlist}
                musicAvailable={musicAvailable}
                onPlay={(shuffle) =>
                  onControl(() => adapter.playPlaylist(playlist.id, shuffle || undefined))
                }
                onPlayTrack={onPlay}
                onRemoveTrack={(trackIndex) => removeTrack(playlist, trackIndex)}
                onRename={(name) => renamePlaylist(playlist.id, name)}
                onRemove={() => removePlaylist(playlist.id)}
              />
            ))}
          </ul>
        )}
        {creatingPlaylist ? (
          <form
            className="flex gap-1 pt-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              const name = newPlaylistName.trim()
              if (!name) return
              savePlaylist(name)
              setNewPlaylistName('')
              setCreatingPlaylist(false)
            }}
          >
            <input
              autoFocus
              value={newPlaylistName}
              maxLength={48}
              aria-label="New playlist name"
              placeholder="Playlist name…"
              onChange={(event) => setNewPlaylistName(event.target.value)}
              className={`${fieldInput} min-w-0 flex-1`}
            />
            <button
              type="submit"
              disabled={!newPlaylistName.trim()}
              className="h-7 rounded-md bg-accent px-2 text-[11px] font-medium text-fg-on-accent disabled:opacity-40"
            >
              Create
            </button>
            <button
              type="button"
              aria-label="Cancel new playlist"
              className={`${iconButton} !size-7`}
              onClick={() => setCreatingPlaylist(false)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreatingPlaylist(true)}
            className="mt-1 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border text-[11px] text-fg-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <Plus size={11} aria-hidden="true" /> New playlist
          </button>
        )}
      </div>
      {stations.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-2">
          {stations.map((station) => {
            const selected =
              current !== null &&
              (current.id === station.id ||
                current.station === station.title ||
                current.title === station.title)
            return (
              <button
                key={station.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onPlay(station.id)}
                className={`h-6 max-w-full truncate rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                  selected
                    ? 'border-accent/25 bg-accent/15 text-accent'
                    : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {station.title}
              </button>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function PlaylistRow({
  playlist,
  musicAvailable,
  onPlay,
  onPlayTrack,
  onRemoveTrack,
  onRename,
  onRemove,
}: {
  playlist: AriPlaylist
  musicAvailable: boolean
  onPlay: (shuffle: boolean) => void
  onPlayTrack: (trackId: string) => void
  onRemoveTrack: (trackIndex: number) => void
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(playlist.name)
  const playable = musicAvailable && playlist.tracks.length > 0

  return (
    <li className="border-b border-border/60 py-1 last:border-b-0">
      {editing ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            onRename(name.trim())
            setEditing(false)
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={48}
            aria-label={`Rename ${playlist.name}`}
            onChange={(event) => setName(event.target.value)}
            className={`${fieldInput} min-w-0 flex-1`}
          />
          <button type="submit" className={`${iconButton} !size-6`} aria-label="Save name">
            <Pencil size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${iconButton} !size-6`}
            aria-label="Cancel rename"
            onClick={() => {
              setName(playlist.name)
              setEditing(false)
            }}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${playlist.name}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className={`${iconButton} !size-6`}
          >
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={`transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
            />
          </button>
          <button
            type="button"
            aria-label={`Play ${playlist.name}`}
            disabled={!playable}
            onClick={() => onPlay(false)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
          >
            <ListMusic size={11} aria-hidden="true" className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">
              {playlist.name}
              <span className="font-normal text-fg-subtle"> · {playlist.tracks.length}</span>
            </span>
            <Play size={10} aria-hidden="true" className="shrink-0" />
          </button>
          <button
            type="button"
            aria-label={`Shuffle ${playlist.name}`}
            disabled={!playable}
            className={`${iconButton} !size-6`}
            onClick={() => onPlay(true)}
          >
            <Shuffle size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Rename ${playlist.name}`}
            className={`${iconButton} !size-6`}
            onClick={() => setEditing(true)}
          >
            <Pencil size={11} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${playlist.name}`}
            className={`${iconButton} !size-6 hover:text-danger`}
            onClick={onRemove}
          >
            <Trash2 size={11} aria-hidden="true" />
          </button>
        </div>
      )}
      {expanded ? (
        playlist.tracks.length > 0 ? (
          <ol className="ml-6 pt-1">
            {playlist.tracks.map((track, index) => (
              <li
                key={`${track.sourceUrl || track.id}-${index}`}
                className="flex items-center gap-1"
              >
                <button
                  type="button"
                  disabled={!musicAvailable}
                  onClick={() => onPlayTrack(track.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
                >
                  <Play size={10} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 truncate">
                    {track.title}
                    {track.artist ? (
                      <span className="text-fg-subtle"> · {track.artist}</span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${track.title} from ${playlist.name}`}
                  className={`${iconButton} !size-6 hover:text-danger`}
                  onClick={() => onRemoveTrack(index)}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ml-7 py-1 text-[11px] text-fg-subtle">
            Empty playlist — paste a song link above, then choose this playlist.
          </p>
        )
      ) : null}
    </li>
  )
}

function ResolvedTrack({
  track,
  playlists,
  onPlay,
  onQueue,
  onSave,
}: {
  track: FocusTrack
  playlists: AriPlaylist[]
  onPlay: () => void
  onQueue: () => void
  onSave: (playlistId: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="pt-1.5">
      <p className="truncate text-xs text-fg">
        {track.title}
        {track.artist ? <span className="text-fg-subtle"> — {track.artist}</span> : null}
      </p>
      <div className="flex gap-1 pt-1">
        <button
          type="button"
          className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`}
          onClick={onPlay}
        >
          Play
        </button>
        <button
          type="button"
          className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`}
          onClick={onQueue}
        >
          Queue
        </button>
        <button
          type="button"
          aria-label="Choose playlist"
          aria-expanded={pickerOpen}
          disabled={playlists.length === 0}
          onClick={() => setPickerOpen((value) => !value)}
          className={`${iconButton} !h-6 !w-auto flex-1 justify-between px-2 text-[11px]`}
        >
          Add to playlist
          <ChevronDown
            size={11}
            aria-hidden="true"
            className={`transition-transform ${pickerOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {playlists.length === 0 ? (
        <p className="pt-1 text-[10px] text-fg-subtle">
          Create a playlist below to save this song.
        </p>
      ) : null}
      {pickerOpen ? (
        <div
          role="menu"
          aria-label="Playlists"
          className="ari-focus-scroll mt-1 max-h-28 overflow-y-auto rounded-md border border-border bg-surface-2 p-1"
        >
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onSave(playlist.id)
                setPickerOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[11px] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <span className="truncate">{playlist.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
                {playlist.tracks.length}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TimerSection({ timer }: { timer: FocusTimerHandle }) {
  const [name, setName] = useState('')
  const [preset, setPreset] = useState(25)
  const [custom, setCustom] = useState('')
  const active = timer.status === 'running' || timer.status === 'paused'
  const progress = active && timer.durationMs > 0 ? 1 - timer.remainingMs / timer.durationMs : 0

  return (
    <section aria-label="Focus timer" className="mt-2.5 border-t border-border pt-2.5">
      {timer.status === 'finished' ? (
        <p role="status" className="pb-1.5 text-[11px] font-medium text-accent">
          {truncateTimerName(timer.name)} — done. Nice work.
        </p>
      ) : null}
      {active ? (
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-xs font-medium text-fg">
              {truncateTimerName(timer.name)} ·{' '}
              <span className="font-mono tabular-nums">
                {formatTimerRemaining(timer.remainingMs)}
              </span>
              {timer.status === 'paused' ? <span className="text-fg-subtle"> · paused</span> : null}
            </p>
            <div className="flex shrink-0 gap-1">
              {timer.status === 'running' ? (
                <button
                  type="button"
                  onClick={timer.pause}
                  className={`${iconButton} !size-6`}
                  aria-label="Pause timer"
                >
                  <Pause size={12} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={timer.resume}
                  className={`${iconButton} !size-6`}
                  aria-label="Resume timer"
                >
                  <Play size={12} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={timer.cancel}
                className={`${iconButton} !size-6`}
                aria-label="Cancel timer"
              >
                <Timer size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div
            role="progressbar"
            aria-label={`${truncateTimerName(timer.name)} progress`}
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const minutes = custom.trim() ? Number(custom) : preset
            if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) return
            timer.start(name, minutes * 60_000)
            setName('')
            setCustom('')
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Timer name (e.g. Grind)"
            aria-label="Timer name"
            maxLength={32}
            className={`${fieldInput} w-full`}
          />
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
            {FOCUS_TIMER_PRESETS_MIN.map((minutes) => (
              <button
                key={minutes}
                type="button"
                aria-pressed={preset === minutes && !custom.trim()}
                onClick={() => {
                  setPreset(minutes)
                  setCustom('')
                }}
                className={`h-6 rounded-full border px-2 text-[11px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                  preset === minutes && !custom.trim()
                    ? 'border-accent/25 bg-accent/15 text-accent'
                    : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {minutes}m
              </button>
            ))}
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              placeholder="Custom min"
              aria-label="Custom duration in minutes"
              inputMode="numeric"
              className={`${fieldInput} w-16 tabular-nums`}
            />
          </div>
          <button
            type="submit"
            className="mt-1.5 h-7 w-full rounded-md bg-accent text-xs font-medium text-fg-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Start
          </button>
        </form>
      )}
    </section>
  )
}

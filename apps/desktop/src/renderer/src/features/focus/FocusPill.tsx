import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ListMusic,
  Music,
  Pause,
  Play,
  Plus,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Timer,
  Volume2,
} from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import { CliampAdapter } from './cliamp-adapter'
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
  const adapter = useMemo(() => service ?? new CliampAdapter(), [service])
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

  useEffect(() => {
    if (!open && !music.playing) return
    const id = window.setInterval(() => {
      void refreshMusic()
    }, MUSIC_POLL_MS)
    return () => window.clearInterval(id)
  }, [open, music.playing, refreshMusic])

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
        <Popover.Content align="end" aria-label="Focus" className="w-72 max-w-[calc(100vw-24px)]">
          <MusicSection
            musicAvailable={music.available}
            track={music.track}
            playing={music.playing}
            shuffled={music.shuffle}
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
          {music.available ? (
            <LibrarySection
              adapter={adapter}
              supportsSearch={music.supportsSearch}
              current={music.track}
              onPlay={(id) => void runControl(() => adapter.play(id))}
              onControl={(action) => void runControl(action)}
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
  detail,
  onControl,
  onRetry,
  adapter,
}: {
  musicAvailable: boolean
  track: FocusTrack | null
  playing: boolean
  shuffled: boolean
  detail: string
  onControl: (
    action: () => Promise<{ ok: boolean; error?: string }>,
    optimistic?: Partial<{ playing: boolean }>,
  ) => void
  onRetry: () => void
  adapter: MusicService
}) {
  return (
    <section aria-label="Music">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-fg">
          {track ? track.title : musicAvailable ? 'No track playing' : 'Music unavailable'}
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
  return (
    <section
      aria-label="Volume"
      className="flex items-center gap-2 border-t border-border pt-2.5 mt-2.5"
    >
      <Volume2 size={13} aria-hidden="true" className="shrink-0 text-fg-subtle" />
      <input
        type="range"
        min={0}
        max={100}
        value={shown}
        aria-label={`Volume ${shown}%`}
        onChange={(event) => {
          const next = Number(event.target.value)
          setDraft(next)
          if (commitTimer.current !== null) window.clearTimeout(commitTimer.current)
          commitTimer.current = window.setTimeout(() => {
            void adapter.setVolume(next).then(onDone)
          }, VOLUME_COMMIT_MS)
        }}
        className="h-1 w-full accent-accent"
      />
      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-muted">
        {shown}
      </span>
    </section>
  )
}

function LibrarySection({
  adapter,
  supportsSearch,
  current,
  onPlay,
  onControl,
}: {
  adapter: MusicService
  supportsSearch: boolean
  current: FocusTrack | null
  onPlay: (trackId: string) => void
  onControl: (action: () => Promise<{ ok: boolean; error?: string }>) => void
}) {
  const [stations, setStations] = useState<FocusTrack[]>([])
  const [playlists, setPlaylists] = useState<AriPlaylist[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FocusTrack[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState<FocusUrlResolve | null>(null)

  const refreshPlaylists = useCallback(() => {
    void adapter.listPlaylists().then(({ playlists: next }) => setPlaylists(next ?? []))
  }, [adapter])

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
    <section aria-label="Library" className="mt-2.5 border-t border-border pt-2.5">
      {stations.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pb-1.5">
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
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          const q = query.trim()
          if (!q || searching) return
          setSearching(true)
          setError(null)
          setResolved(null)
          const youtube = /youtu(\.be|be\.com)/i.test(q)
          const task = youtube
            ? adapter.resolveUrl(q).then((next) => {
                setResolved(next)
                setSearched(false)
                setResults([])
                if (next.kind === 'invalid') setError(next.error)
              })
            : supportsSearch
              ? adapter.search(q).then(({ tracks, error: nextError }) => {
                  setResults(tracks.slice(0, 5))
                  setSearched(true)
                  setError(nextError ?? null)
                })
              : Promise.resolve()
          void task.finally(() => setSearching(false))
        }}
      >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Paste YouTube song or playlist URL…"
              aria-label="Search music"
              className={`${fieldInput} min-w-0 flex-1`}
            />
            <button
              type="submit"
              aria-label="Search"
              disabled={searching || !query.trim()}
              className={iconButton}
            >
              <Search size={13} aria-hidden="true" />
            </button>
          </form>
      {resolved?.kind === 'track' ? (
        <ResolvedTrack
          track={resolved.track}
          playlists={playlists}
          onPlay={() => onPlay(resolved.track.id)}
          onQueue={() => onControl(() => adapter.queue(resolved.track.id))}
          onSave={(playlistId) => {
            const target = playlists.find((row) => row.id === playlistId)
            if (!target) return
            void adapter
              .updatePlaylist(playlistId, [...target.tracks, resolved.track])
              .then(refreshPlaylists)
          }}
          onCreate={() => {
            void adapter.createPlaylist(resolved.track.title, [resolved.track]).then(refreshPlaylists)
          }}
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
            <button
              type="button"
              className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`}
              onClick={() => {
                void adapter.createPlaylist(resolved.name, resolved.tracks).then(refreshPlaylists)
              }}
            >
              Save to Ari
            </button>
          </div>
        </div>
      ) : null}
      {searched ? (
        results.length > 0 ? (
          <ul className="pt-1">
            {results.map((track) => (
              <li key={track.id}>
                <button
                  type="button"
                  onClick={() => onPlay(track.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  <Play size={11} aria-hidden="true" className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
                    {track.title}
                    {track.artist || track.station ? (
                      <span className="text-fg-subtle"> · {track.artist || track.station}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pt-1.5 text-[11px] text-fg-subtle">
            {searching ? 'Searching…' : (error ?? 'No results.')}
          </p>
        )
      ) : null}
      {playlists.length > 0 ? (
        <div className="pt-2" aria-label="Saved playlists">
          <p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
            My playlists
          </p>
          <ul>
            {playlists.map((playlist) => (
              <li key={playlist.id} className="py-0.5">
                <div className="flex items-center gap-1">
                  <ListMusic size={11} aria-hidden="true" className="shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg">{playlist.name}</span>
                  <button
                    type="button"
                    aria-label={`Play ${playlist.name}`}
                    className={`${iconButton} !size-6`}
                    onClick={() => onControl(() => adapter.playPlaylist(playlist.id))}
                  >
                    <Play size={11} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Shuffle ${playlist.name}`}
                    className={`${iconButton} !size-6`}
                    onClick={() => onControl(() => adapter.playPlaylist(playlist.id, true))}
                  >
                    <Shuffle size={11} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function ResolvedTrack({
  track,
  playlists,
  onPlay,
  onQueue,
  onSave,
  onCreate,
}: {
  track: FocusTrack
  playlists: AriPlaylist[]
  onPlay: () => void
  onQueue: () => void
  onSave: (playlistId: string) => void
  onCreate: () => void
}) {
  return (
    <div className="pt-1.5">
      <p className="truncate text-xs text-fg">
        {track.title}
        {track.artist ? <span className="text-fg-subtle"> — {track.artist}</span> : null}
      </p>
      <div className="flex flex-wrap gap-1 pt-1">
        <button type="button" className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`} onClick={onPlay}>
          Play
        </button>
        <button type="button" className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`} onClick={onQueue}>
          Queue
        </button>
        <button type="button" className={`${iconButton} !h-6 !w-auto px-2 text-[11px]`} onClick={onCreate}>
          <Plus size={10} aria-hidden="true" /> Playlist
        </button>
        {playlists.slice(0, 3).map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            className={`${iconButton} !h-6 !w-auto max-w-24 truncate px-2 text-[11px]`}
            onClick={() => onSave(playlist.id)}
          >
            + {playlist.name}
          </button>
        ))}
      </div>
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

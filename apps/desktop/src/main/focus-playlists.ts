import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AriPlaylist, FocusTrack } from '@ari/contracts/rpc'
import { newId } from '@ari/shared/ids'

export const FOCUS_PLAYLISTS_FILE = 'focus-playlists.v1.json'
const NAME_MAX = 48
const TRACKS_MAX = 200

export interface FocusPlaylistStore {
  list(): Promise<AriPlaylist[]>
  create(name: string, tracks?: FocusTrack[]): Promise<AriPlaylist>
  rename(id: string, name: string): Promise<AriPlaylist | null>
  remove(id: string): Promise<boolean>
  replaceTracks(id: string, tracks: FocusTrack[]): Promise<AriPlaylist | null>
}

function sanitizeName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX)
  return trimmed.length > 0 ? trimmed : 'Playlist'
}

function trackKey(track: FocusTrack): string {
  return track.sourceUrl?.trim() || track.id.trim()
}

function sanitizeTracks(tracks: FocusTrack[]): FocusTrack[] {
  const seen = new Set<string>()
  return tracks
    .filter((track) => {
      const key = trackKey(track)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, TRACKS_MAX)
}

function playlistFingerprint(name: string, tracks: FocusTrack[]): string {
  return `${sanitizeName(name).toLocaleLowerCase()}\n${tracks.map(trackKey).join('\n')}`
}

function parseStored(raw: string): AriPlaylist[] {
  const parsed: unknown = JSON.parse(raw)
  const root =
    typeof parsed === 'object' && parsed !== null ? (parsed as { playlists?: unknown }) : null
  if (!Array.isArray(root?.playlists)) return []
  const seen = new Set<string>()
  return root.playlists.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Partial<AriPlaylist>
    if (typeof row.id !== 'string' || typeof row.name !== 'string' || !Array.isArray(row.tracks)) {
      return []
    }
    const playlist = {
      id: row.id,
      name: sanitizeName(row.name),
      tracks: sanitizeTracks(
        row.tracks.filter(
          (track): track is FocusTrack =>
            typeof track === 'object' &&
            track !== null &&
            typeof track.id === 'string' &&
            typeof track.title === 'string',
        ),
      ),
    }
    const fingerprint = playlistFingerprint(playlist.name, playlist.tracks)
    if (seen.has(fingerprint)) return []
    seen.add(fingerprint)
    return [playlist]
  })
}

export function createFocusPlaylistStore(dir: string): FocusPlaylistStore {
  const path = join(dir, FOCUS_PLAYLISTS_FILE)
  let cache: AriPlaylist[] | null = null
  let mutation: Promise<void> = Promise.resolve()

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutation.then(operation, operation)
    mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function load(): Promise<AriPlaylist[]> {
    if (cache) return cache
    try {
      cache = parseStored(await readFile(path, 'utf8'))
    } catch {
      cache = []
    }
    return cache
  }

  async function persist(playlists: AriPlaylist[]): Promise<void> {
    await mkdir(dir, { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify({ playlists }, null, 2), 'utf8')
    await rename(tmp, path)
    cache = playlists
  }

  return {
    async list() {
      return load()
    },
    create(name, tracks = []) {
      return mutate(async () => {
        const playlist: AriPlaylist = {
          id: newId('fpl'),
          name: sanitizeName(name),
          tracks: sanitizeTracks(tracks),
        }
        const playlists = await load()
        const fingerprint = playlistFingerprint(playlist.name, playlist.tracks)
        const existing = playlists.find(
          (row) => playlistFingerprint(row.name, row.tracks) === fingerprint,
        )
        if (existing) return existing
        await persist([...playlists, playlist])
        return playlist
      })
    },
    rename(id, name) {
      return mutate(async () => {
        const playlists = await load()
        const current = playlists.find((row) => row.id === id)
        if (!current) return null
        const next = { ...current, name: sanitizeName(name) }
        await persist(playlists.map((row) => (row.id === id ? next : row)))
        return next
      })
    },
    remove(id) {
      return mutate(async () => {
        const playlists = await load()
        if (!playlists.some((row) => row.id === id)) return false
        await persist(playlists.filter((row) => row.id !== id))
        return true
      })
    },
    replaceTracks(id, tracks) {
      return mutate(async () => {
        const playlists = await load()
        const current = playlists.find((row) => row.id === id)
        if (!current) return null
        const next = { ...current, tracks: sanitizeTracks(tracks) }
        await persist(playlists.map((row) => (row.id === id ? next : row)))
        return next
      })
    },
  }
}

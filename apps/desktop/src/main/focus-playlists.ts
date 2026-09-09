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

function sanitizeTracks(tracks: FocusTrack[]): FocusTrack[] {
  return tracks.slice(0, TRACKS_MAX)
}

function parseStored(raw: string): AriPlaylist[] {
  const parsed: unknown = JSON.parse(raw)
  const root = typeof parsed === 'object' && parsed !== null ? (parsed as { playlists?: unknown }) : null
  if (!Array.isArray(root?.playlists)) return []
  return root.playlists.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Partial<AriPlaylist>
    if (typeof row.id !== 'string' || typeof row.name !== 'string' || !Array.isArray(row.tracks)) {
      return []
    }
    return [
      {
        id: row.id,
        name: row.name,
        tracks: row.tracks.filter(
          (track): track is FocusTrack =>
            typeof track === 'object' &&
            track !== null &&
            typeof track.id === 'string' &&
            typeof track.title === 'string',
        ),
      },
    ]
  })
}

export function createFocusPlaylistStore(dir: string): FocusPlaylistStore {
  const path = join(dir, FOCUS_PLAYLISTS_FILE)
  let cache: AriPlaylist[] | null = null

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
    cache = playlists
    await mkdir(dir, { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify({ playlists }, null, 2), 'utf8')
    await rename(tmp, path)
  }

  return {
    async list() {
      return load()
    },
    async create(name, tracks = []) {
      const playlist: AriPlaylist = {
        id: newId('fpl'),
        name: sanitizeName(name),
        tracks: sanitizeTracks(tracks),
      }
      const playlists = await load()
      await persist([...playlists, playlist])
      return playlist
    },
    async rename(id, name) {
      const playlists = await load()
      const current = playlists.find((row) => row.id === id)
      if (!current) return null
      const next = { ...current, name: sanitizeName(name) }
      await persist(playlists.map((row) => (row.id === id ? next : row)))
      return next
    },
    async remove(id) {
      const playlists = await load()
      if (!playlists.some((row) => row.id === id)) return false
      await persist(playlists.filter((row) => row.id !== id))
      return true
    },
    async replaceTracks(id, tracks) {
      const playlists = await load()
      const current = playlists.find((row) => row.id === id)
      if (!current) return null
      const next = { ...current, tracks: sanitizeTracks(tracks) }
      await persist(playlists.map((row) => (row.id === id ? next : row)))
      return next
    },
  }
}



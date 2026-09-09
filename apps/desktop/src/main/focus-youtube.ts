import type { FocusTrack } from '@ari/contracts/rpc'

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])

export type YoutubeUrlKind = 'track' | 'playlist'

/** Detects public YouTube / YouTube Music watch vs playlist URLs. */
export function classifyYoutubeUrl(raw: string): YoutubeUrlKind | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  if (!YT_HOSTS.has(host)) return null
  const path = parsed.pathname.toLowerCase()
  const list = parsed.searchParams.get('list')
  const video = parsed.searchParams.get('v')
  if (path.includes('/playlist') && list) return 'playlist'
  if (host === 'youtu.be' || path.includes('/watch') || path.includes('/shorts/') || video) {
    return 'track'
  }
  if (list) return 'playlist'
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function thumbnailUrl(raw: unknown): string {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (!Array.isArray(raw) || raw.length === 0) return ''
  const last = asRecord(raw[raw.length - 1])
  return asString(last?.['url']) ?? ''
}

export function youtubeTrackFromDump(dump: unknown): FocusTrack | null {
  const row = asRecord(dump)
  if (!row) return null
  const title = asString(row['track']) ?? asString(row['title'])
  const url =
    asString(row['webpage_url']) ??
    asString(row['original_url']) ??
    asString(row['url']) ??
    (asString(row['id']) ? `https://www.youtube.com/watch?v=${asString(row['id'])}` : null)
  if (!title || !url) return null
  const duration = asNumber(row['duration'])
  return {
    id: url,
    title,
    artist:
      asString(row['artist']) ??
      asString(row['creator']) ??
      asString(row['channel']) ??
      asString(row['uploader']) ??
      '',
    station: '',
    sourceUrl: url,
    artworkUrl: thumbnailUrl(row['thumbnail'] ?? row['thumbnails']),
    durationMs: duration !== null ? Math.round(duration * 1000) : undefined,
  }
}

export function youtubePlaylistFromDump(dump: unknown): { name: string; tracks: FocusTrack[] } | null {
  const row = asRecord(dump)
  if (!row) return null
  const entries = row['entries']
  if (!Array.isArray(entries)) return null
  const tracks = entries.flatMap((entry) => {
    const track = youtubeTrackFromDump(entry)
    return track ? [track] : []
  })
  if (tracks.length === 0) return null
  return {
    name: asString(row['title']) ?? 'YouTube playlist',
    tracks,
  }
}

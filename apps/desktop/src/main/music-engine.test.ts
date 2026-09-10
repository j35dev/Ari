import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MusicEngine } from './music-engine'
import { MusicRuntime } from './music-runtime'

const TRACK_URL = 'https://www.youtube.com/watch?v=abc123'

function trackDump() {
  return {
    title: 'Test Song',
    webpage_url: TRACK_URL,
    duration: 213,
    uploader: 'Test Artist',
    thumbnails: [{ url: 'https://img/thumb.jpg' }],
  }
}

function engineWith(
  helper: (args: string[]) => unknown,
  options?: { helperBinary?: string | null; status?: 'ready' | 'downloading' | 'missing' },
) {
  const runtime = new MusicRuntime({ appPath: '/none', resourcesPath: '', isPackaged: true })
  vi.spyOn(runtime, 'ensure').mockResolvedValue(options?.helperBinary ?? '/cache/yt-dlp')
  vi.spyOn(runtime, 'status').mockResolvedValue(options?.status ?? 'ready')
  const runHelper = async (args: string[]) => ({ stdout: JSON.stringify(helper(args)) })
  return new MusicEngine({ env: { appPath: '/none', resourcesPath: '' }, runHelper, runtime })
}

describe('MusicEngine', () => {
  it('rejects non-YouTube URLs without touching the helper', async () => {
    const runHelper = vi.fn(async () => ({ stdout: '{}' }))
    const runtime = new MusicRuntime({ appPath: '/none', resourcesPath: '' })
    vi.spyOn(runtime, 'ensure').mockResolvedValue('/cache/yt-dlp')
    const engine = new MusicEngine({ env: { appPath: '/none', resourcesPath: '' }, runHelper, runtime })
    expect(await engine.resolveUrl('https://example.com/song')).toEqual({
      kind: 'invalid',
      error: 'Paste a YouTube song or playlist link.',
    })
    expect(runHelper).not.toHaveBeenCalled()
  })

  it('resolves a single track to lightweight metadata', async () => {
    const engine = engineWith(() => trackDump())
    const resolved = await engine.resolveUrl(TRACK_URL)
    expect(resolved).toMatchObject({
      kind: 'track',
      track: { title: 'Test Song', artist: 'Test Artist', sourceUrl: TRACK_URL },
    })
  })

  it('resolves a playlist into track records, never audio', async () => {
    const engine = engineWith(() => ({
      title: 'Mix',
      entries: [
        { ...trackDump(), webpage_url: `${TRACK_URL}1`, title: 'One' },
        { ...trackDump(), webpage_url: `${TRACK_URL}2`, title: 'Two' },
      ],
    }))
    const resolved = await engine.resolveUrl('https://www.youtube.com/playlist?list=xyz')
    expect(resolved).toMatchObject({ kind: 'playlist', name: 'Mix' })
    if (resolved.kind === 'playlist') expect(resolved.tracks).toHaveLength(2)
  })

  it('reports unplayable dumps as invalid', async () => {
    const engine = engineWith(() => ({ nope: true }))
    expect(await engine.resolveUrl(TRACK_URL)).toMatchObject({ kind: 'invalid' })
  })

  it('names the preparing state while the helper downloads', async () => {
    const runtime = new MusicRuntime({ appPath: '/none', resourcesPath: '' })
    vi.spyOn(runtime, 'ensure').mockResolvedValue(null)
    vi.spyOn(runtime, 'status').mockResolvedValue('downloading')
    const engine = new MusicEngine({
      env: { appPath: '/none', resourcesPath: '' },
      runHelper: async () => ({ stdout: '{}' }),
      runtime,
    })
    expect(await engine.resolveUrl(TRACK_URL)).toEqual({
      kind: 'invalid',
      error: 'Preparing Focus Music…',
    })
    expect(await engine.runtimeStatus()).toMatchObject({ state: 'downloading' })
  })

  it('searches without accounts and returns track records', async () => {
    const seen: string[][] = []
    const engine = engineWith((args) => {
      seen.push(args)
      return { entries: [{ ...trackDump(), title: 'Found' }] }
    })
    const { tracks } = await engine.search('lofi beats')
    expect(tracks.map((track) => track.title)).toEqual(['Found'])
    expect(seen[0]?.join(' ')).toContain('ytsearch8:lofi beats')
  })

  it('browse returns no tracks without a radio backend', async () => {
    const engine = engineWith(() => ({}))
    expect(await engine.browse()).toEqual({ tracks: [] })
  })

  it('persists playlists as tiny source records across instances', async () => {
    const data = await mkdtemp(join(tmpdir(), 'ari-music-playlists-'))
    const env = { appPath: '/none', resourcesPath: '', userDataPath: data }
    const first = new MusicEngine({ env, runHelper: async () => ({ stdout: '{}' }) })
    const created = await first.createPlaylist('Evening', [
      {
        id: TRACK_URL,
        title: 'Test Song',
        artist: 'Test Artist',
        station: '',
        sourceUrl: TRACK_URL,
      },
    ])
    expect(created.playlist?.tracks).toHaveLength(1)
    const second = new MusicEngine({ env, runHelper: async () => ({ stdout: '{}' }) })
    expect(await second.getPlaylist(created.playlist?.id ?? '')).toMatchObject({
      playlist: { name: 'Evening' },
    })
    expect((await second.listPlaylists()).playlists).toHaveLength(1)
  })
})

describe('MusicEngine streaming', () => {
  function streamingEngine(stdout: string) {
    const runtime = new MusicRuntime({ appPath: '/none', resourcesPath: '' })
    vi.spyOn(runtime, 'ensure').mockResolvedValue('/cache/yt-dlp')
    vi.spyOn(runtime, 'status').mockResolvedValue('ready')
    return new MusicEngine({
      env: { appPath: '/none', resourcesPath: '' },
      runHelper: async () => ({ stdout }),
      runtime,
    })
  }

  it('returns the direct audio URL', async () => {
    const engine = streamingEngine('https://rr1---sn.googlevideo.com/videoplayback?x=1\n')
    expect(await engine.streamTrack(TRACK_URL)).toEqual({
      url: 'https://rr1---sn.googlevideo.com/videoplayback?x=1',
    })
  })

  it('rejects non-URL track ids and non-http streams', async () => {
    const engine = streamingEngine('file:///etc/passwd\n')
    expect(await engine.streamTrack('not a url')).toMatchObject({ url: null })
    expect(await engine.streamTrack(TRACK_URL)).toMatchObject({ url: null })
  })
})

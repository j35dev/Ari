import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MusicEngine, classifyHelperError, errorCodeOf, videoIdFromUrl } from './music-engine'
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

describe('music error classification', () => {
  it('separates unavailable, network, extractor, and timeout failures', () => {
    expect(classifyHelperError('ERROR: Private video', false)).toBe('TRACK_UNAVAILABLE')
    expect(classifyHelperError('ERROR: Video unavailable', false)).toBe('TRACK_UNAVAILABLE')
    expect(classifyHelperError('ERROR: Requested format is not available', false)).toBe(
      'RUNTIME_UPDATE_REQUIRED',
    )
    expect(classifyHelperError('ERROR: Unable to download: network unreachable', false)).toBe(
      'NETWORK_ERROR',
    )
    expect(classifyHelperError('ERROR: Unable to extract uploader id', false)).toBe(
      'RUNTIME_UPDATE_REQUIRED',
    )
    expect(classifyHelperError('nsig extraction failed', false)).toBe('RUNTIME_UPDATE_REQUIRED')
    expect(classifyHelperError('anything', true)).toBe('RESOLVE_TIMEOUT')
    expect(classifyHelperError('weird output', false)).toBe('PLAYBACK_ERROR')
  })

  it('reads codes off errors and defaults unknown throws', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }))).toBe(
      'NETWORK_ERROR',
    )
    expect(errorCodeOf(new Error('plain'))).toBe('PLAYBACK_ERROR')
    expect(errorCodeOf(null)).toBe('PLAYBACK_ERROR')
  })

  it('extracts loggable video ids without query strings', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=abc123&list=xyz')).toBe('abc123')
    expect(videoIdFromUrl('https://youtu.be/abc123')).toBe('abc123')
    expect(videoIdFromUrl('not a url')).toBe('not a url')
  })
})

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
      code: 'RUNTIME_MISSING',
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

describe('MusicEngine runtime self-heal', () => {
  const REMOTE_URL = 'https://example.invalid/music-runtime.json'
  const KEY = process.platform === 'win32' ? 'win32-x64' : 'linux-x64'
  const BINARY = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const V1 = Buffer.from('v1-bytes')
  const V1_SHA = createHash('sha256').update(V1).digest('hex')
  const V2 = Buffer.from('v2-bytes')
  const V2_SHA = createHash('sha256').update(V2).digest('hex')

  function manifest(version: string, sha: string) {
    return {
      schemaVersion: 1,
      runtimeVersion: version,
      platforms: {
        [KEY]: { url: 'https://example.invalid/h', sha256: sha, binary: BINARY, size: 8 },
      },
    }
  }

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'ari-music-heal-'))
    await mkdir(join(root, 'resources'), { recursive: true })
    await writeFile(
      join(root, 'resources', 'music-runtime.json'),
      JSON.stringify(manifest('9.9.9', '0'.repeat(64))),
    )
    const data = join(root, 'data')
    const live = { remote: manifest('1.0.0', V1_SHA), bytes: V1 }
    let manifestFetches = 0
    const fetchImpl = (async (url: string) => {
      if (url === REMOTE_URL) {
        manifestFetches++
        return new Response(JSON.stringify(live.remote), { status: 200 })
      }
      return new Response(Uint8Array.from(live.bytes), { status: 200 })
    }) as typeof fetch
    const runtime = new MusicRuntime(
      { resourcesPath: '', appPath: root, userDataPath: data, manifestUrl: REMOTE_URL },
      fetchImpl,
    )
    return { runtime, live, manifestFetches: () => manifestFetches }
  }

  function coded(message: string, code: string): Error {
    return Object.assign(new Error(message), { code })
  }

  it('refreshes a broken runtime once and retries the resolve', async () => {
    const { runtime, live, manifestFetches } = await setup()
    let helperCalls = 0
    const runHelper = async (): Promise<{ stdout: string }> => {
      helperCalls++
      if (helperCalls === 1) throw coded('ERROR: Unable to extract uploader id', 'RUNTIME_UPDATE_REQUIRED')
      return { stdout: JSON.stringify(trackDump()) }
    }
    const engine = new MusicEngine({
      env: { resourcesPath: '', appPath: '/none', userDataPath: '/none' },
      runHelper,
      runtime,
    })
    // v1 seeds the cache; v2 appears before the failing resolve.
    await runtime.ensure()
    live.remote = manifest('2.0.0', V2_SHA)
    live.bytes = V2
    const resolved = await engine.resolveUrl(TRACK_URL)
    expect(resolved).toMatchObject({ kind: 'track' })
    expect(helperCalls).toBe(2)
    expect(manifestFetches()).toBe(2)
    expect(await runtime.installedVersion()).toBe('2.0.0')
  })

  it('never refreshes the runtime for per-video failures', async () => {
    const { runtime, manifestFetches } = await setup()
    let helperCalls = 0
    const runHelper = async (): Promise<{ stdout: string }> => {
      helperCalls++
      throw coded('ERROR: Private video', 'TRACK_UNAVAILABLE')
    }
    const engine = new MusicEngine({
      env: { resourcesPath: '', appPath: '/none', userDataPath: '/none' },
      runHelper,
      runtime,
    })
    const resolved = await engine.resolveUrl(TRACK_URL)
    expect(resolved).toEqual({
      kind: 'invalid',
      error: "This track isn't available.",
      code: 'TRACK_UNAVAILABLE',
    })
    expect(helperCalls).toBe(1)
    expect(manifestFetches()).toBe(1)
  })

  it('gives up when no newer runtime exists', async () => {
    const { runtime } = await setup()
    let helperCalls = 0
    const runHelper = async (): Promise<{ stdout: string }> => {
      helperCalls++
      throw coded('ERROR: Unable to extract signature', 'RUNTIME_UPDATE_REQUIRED')
    }
    const engine = new MusicEngine({
      env: { resourcesPath: '', appPath: '/none', userDataPath: '/none' },
      runHelper,
      runtime,
    })
    const resolved = await engine.resolveUrl(TRACK_URL)
    expect(resolved).toMatchObject({ kind: 'invalid', code: 'RUNTIME_UPDATE_REQUIRED' })
    expect(helperCalls).toBe(1)
  })
})

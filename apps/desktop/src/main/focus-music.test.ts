import { describe, expect, it, vi, type Mock } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FocusMusicBackend,
  cliampBundleDir,
  cliampTargetKey,
  dbToSlider,
  formatDb,
  parseCliampStatus,
  parseRemoteResult,
  sliderToDb,
} from './focus-music'
import type { CliampEnvironment, DaemonHandle, FocusMusicRunner } from './focus-music'

const ENV: CliampEnvironment = { isPackaged: false, resourcesPath: '/none', appPath: '/none' }

function statusJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, state: 'stopped', ...extra })
}

function envelope(result: unknown): string {
  return JSON.stringify({
    version: 2,
    id: 'cliamp',
    ok: true,
    job: { id: 'job1', operation: 'op', state: 'succeeded', result },
  })
}

/**
 * Backend with a fake process table: `daemonUp` flips the instance probe,
 * so tests distinguish Adopt (already running) from Spawn (Ari starts it).
 */
function spawningBackend(
  options: {
    binary?: string | null
    daemonUp?: boolean
    spawnBringsUp?: boolean
    providers?: { key: string; name: string; searchable: boolean }[]
    searchTracks?: Record<string, { title: string; path: string }[]>
    env?: CliampEnvironment
  } = {},
): {
  backend: FocusMusicBackend
  run: Mock<(args: string[], timeoutMs: number) => Promise<{ stdout: string }>>
  spawnDaemon: Mock<(binary: string, args: string[]) => DaemonHandle>
  kill: Mock<() => boolean>
  locateBinary: Mock<() => Promise<string | null>>
  setDaemonUp: (up: boolean) => void
} {
  let daemonUp = options.daemonUp ?? false
  const kill = vi.fn(() => true)
  const spawnDaemon = vi.fn((_binary: string, _args: string[]): DaemonHandle => {
    if (options.spawnBringsUp ?? true) daemonUp = true
    return { exitCode: null, kill }
  })
  const run = vi.fn((args: string[], _timeoutMs: number) => {
    if (args[0] === 'status') {
      return daemonUp
        ? Promise.resolve({ stdout: statusJson() })
        : Promise.reject(new Error('no daemon'))
    }
    if (args[0] === 'remote') {
      if (args[2] === 'provider.list') {
        return Promise.resolve({
          stdout: envelope({
            providers: options.providers ?? [
              { key: 'radio', name: 'Radio', searchable: true },
              { key: 'podcast', name: 'Podcasts', searchable: true },
            ],
          }),
        })
      }
      if (args[2] === 'provider.search') {
        const params = JSON.parse(args[4] as string) as { provider: string }
        const tracks = options.searchTracks?.[params.provider] ?? [
          { title: `${params.provider} hit`, path: `https://${params.provider}.example/stream` },
        ]
        return Promise.resolve({ stdout: envelope({ tracks }) })
      }
      if (args[2] === 'track.play') {
        return Promise.resolve({ stdout: envelope({ ok: true }) })
      }
      return Promise.reject(new Error(`unexpected op ${String(args[2])}`))
    }
    return Promise.resolve({ stdout: '' })
  })
  const locateBinary = vi.fn(() =>
    Promise.resolve(options.binary === undefined ? '/bin/cliamp' : options.binary),
  )
  const runner: FocusMusicRunner = { locateBinary, run }
  const backend = new FocusMusicBackend({
    env: options.env ?? ENV,
    runner,
    spawnDaemon,
    delay: () => Promise.resolve(),
  })
  return {
    backend,
    run,
    spawnDaemon,
    kill,
    locateBinary,
    setDaemonUp: (up) => {
      daemonUp = up
    },
  }
}

describe('parseCliampStatus', () => {
  it('reads stopped, playing, and paused states with station metadata', () => {
    expect(parseCliampStatus(statusJson())).toEqual({ playing: false, track: null })
    expect(
      parseCliampStatus(
        statusJson({
          state: 'playing',
          track: {
            title: 'franceinfo-midfi',
            path: 'http://example/stream.mp3',
            stream: true,
            stream_title: 'Live News',
            artist: 'France Info',
            station: 'France Info',
          },
        }),
      ),
    ).toEqual({
      playing: true,
      track: {
        id: 'http://example/stream.mp3',
        title: 'Live News',
        artist: 'France Info',
        station: 'France Info',
      },
    })
    expect(
      parseCliampStatus(statusJson({ state: 'paused', track: { title: 'Song' } })),
    ).toEqual({
      playing: false,
      track: { id: 'Song', title: 'Song', artist: '', station: '' },
    })
  })

  it('returns null for garbage and failure envelopes', () => {
    expect(parseCliampStatus('not json')).toBeNull()
    expect(parseCliampStatus('{}')).toBeNull()
    expect(parseCliampStatus(JSON.stringify({ ok: false, error: 'nope' }))).toBeNull()
  })
})

describe('parseRemoteResult', () => {
  it('unwraps succeeded jobs and rejects everything else', () => {
    expect(parseRemoteResult(envelope({ tracks: [] }))).toEqual({ tracks: [] })
    expect(
      parseRemoteResult(
        JSON.stringify({ ok: true, job: { state: 'failed', result: { error: 'x' } } }),
      ),
    ).toBeNull()
    expect(parseRemoteResult('garbage')).toBeNull()
  })
})

describe('volume mapping', () => {
  it('covers the full dB range in both directions', () => {
    expect(sliderToDb(0)).toBe(-30)
    expect(sliderToDb(100)).toBe(6)
    expect(dbToSlider(-30)).toBe(0)
    expect(dbToSlider(6)).toBe(100)
    expect(dbToSlider(0)).toBe(83)
    expect(formatDb(0)).toBe('0')
    expect(formatDb(-12.5)).toBe('-12.5')
  })
})

describe('bundled resolution', () => {
  it('maps runtimes to manifest keys and bundle dirs', () => {
    expect(cliampTargetKey('win32', 'x64')).toBe('win32-x64')
    expect(cliampTargetKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(cliampTargetKey('linux', 'ia32')).toBeNull()
    expect(cliampTargetKey('freebsd', 'x64')).toBeNull()
    expect(
      cliampBundleDir(
        { isPackaged: true, resourcesPath: '/res', appPath: '/app' },
        'win32-x64',
      ),
    ).toBe(join('/res', 'cliamp', 'bin', 'win32-x64'))
  })

  it('uses the bundled binary in production and never PATH', async () => {
    const key = cliampTargetKey()
    if (!key) throw new Error('unsupported test platform')
    const root = await mkdtemp(join(tmpdir(), 'ari-cliamp-'))
    const previous = process.env['CLIAMP_BIN']
    delete process.env['CLIAMP_BIN']
    try {
      const dir = join(root, 'cliamp', 'bin', key)
      const binary = join(dir, key.startsWith('win32') ? 'cliamp.exe' : 'cliamp')
      await mkdir(dir, { recursive: true })
      await writeFile(binary, 'dummy')
      const { backend, spawnDaemon, locateBinary } = spawningBackend({
        env: { isPackaged: true, resourcesPath: root, appPath: '/app' },
        binary: '/usr/bin/cliamp',
      })
      await expect(backend.status()).resolves.toMatchObject({ available: true })
      expect(spawnDaemon).toHaveBeenCalledWith(binary, ['--daemon'])
      expect(locateBinary).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env['CLIAMP_BIN']
      else process.env['CLIAMP_BIN'] = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('degrades in production when the bundle is missing instead of using PATH', async () => {
    const previous = process.env['CLIAMP_BIN']
    delete process.env['CLIAMP_BIN']
    try {
      const { backend, spawnDaemon, locateBinary } = spawningBackend({
        env: {
          isPackaged: true,
          resourcesPath: join(tmpdir(), 'ari-cliamp-absent'),
          appPath: '/app',
        },
        binary: '/usr/bin/cliamp',
      })
      const state = await backend.status()
      expect(state).toMatchObject({ available: false })
      expect(state.detail).not.toMatch(/install|PATH|cliamp/i)
      expect(spawnDaemon).not.toHaveBeenCalled()
      expect(locateBinary).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env['CLIAMP_BIN']
      else process.env['CLIAMP_BIN'] = previous
    }
  })
})

describe('FocusMusicBackend', () => {
  it('reports a neutral unavailable state when no binary exists', async () => {
    const { backend, spawnDaemon } = spawningBackend({ binary: null })
    const state = await backend.status()
    expect(state).toMatchObject({ available: false, track: null, volume: null })
    expect(state.detail).not.toMatch(/install|PATH|terminal/i)
    expect(spawnDaemon).not.toHaveBeenCalled()
    await expect(backend.control(['play'])).resolves.toMatchObject({ ok: false })
  })

  it('adopts an already-running instance without spawning; close never kills it', async () => {
    const { backend, run, spawnDaemon, kill } = spawningBackend({ daemonUp: true })
    const state = await backend.status()
    expect(state).toMatchObject({
      available: true,
      playing: false,
      volume: 83,
      supportsSearch: true,
      supportsVolume: true,
    })
    expect(spawnDaemon).not.toHaveBeenCalled()
    await expect(backend.control(['pause'])).resolves.toEqual({ ok: true })
    await expect(backend.control(['prev'])).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['prev'], expect.any(Number))
    backend.close()
    expect(kill).not.toHaveBeenCalled()
    expect(spawnDaemon).not.toHaveBeenCalled()
  })

  it('spawns an owned daemon when none answers; close stops exactly it', async () => {
    const { backend, run, spawnDaemon, kill } = spawningBackend({})
    const state = await backend.status()
    expect(state).toMatchObject({ available: true })
    expect(spawnDaemon).toHaveBeenCalledWith('/bin/cliamp', ['--daemon'])
    await expect(backend.control(['pause'])).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['pause'], expect.any(Number))
    backend.close()
    expect(kill).toHaveBeenCalledTimes(1)
    backend.close()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('cleans up a spawned daemon that never answers and backs off respawns', async () => {
    const { backend, spawnDaemon, kill } = spawningBackend({ spawnBringsUp: false })
    const state = await backend.status()
    expect(state).toMatchObject({ available: false })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledTimes(1)
    await expect(backend.status()).resolves.toMatchObject({ available: false })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  })

  it('merges searchable providers and plays hits with their full object', async () => {
    const { backend, run } = spawningBackend({ daemonUp: true })
    const { tracks, error } = await backend.search('jazz')
    expect(error).toBeUndefined()
    expect(tracks).toHaveLength(2)
    expect(tracks[0]?.id).toMatch(/^https:\/\//)
    await expect(backend.playTrack(tracks[0]?.id)).resolves.toEqual({ ok: true })
    const playArgs = run.mock.calls.find(([args]) => args[2] === 'track.play')?.[0]
    expect(playArgs?.[4]).toContain('https://radio.example/stream')
  })

  it('reports no search support when nothing is searchable', async () => {
    const { backend } = spawningBackend({ daemonUp: true, providers: [] })
    await expect(backend.search('jazz')).resolves.toMatchObject({ tracks: [] })
    await expect(backend.status()).resolves.toMatchObject({ supportsSearch: false })
  })

  it('maps the volume slider to absolute dB and remembers it', async () => {
    const { backend, run } = spawningBackend({ daemonUp: true })
    await expect(backend.setVolume(100)).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['volume', '6'], expect.any(Number))
    await expect(backend.setVolume(0)).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['volume', '-30'], expect.any(Number))
    await expect(backend.status()).resolves.toMatchObject({ volume: 0 })
  })

  it('resumes playback for play without a track id', async () => {
    const { backend, run } = spawningBackend({ daemonUp: true })
    await expect(backend.playTrack()).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith(['play'], expect.any(Number))
  })

  it('adopts a daemon that appears during spawn cooldown', async () => {
    const { backend, spawnDaemon, setDaemonUp } = spawningBackend({ spawnBringsUp: false })
    await expect(backend.status()).resolves.toMatchObject({ available: false })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
    setDaemonUp(true)
    await expect(backend.status()).resolves.toMatchObject({ available: true })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  })

  it('spawns only one owned daemon when two calls race', async () => {
    const { backend, spawnDaemon } = spawningBackend({})
    const [first, second] = await Promise.all([backend.status(), backend.status()])
    expect(first).toMatchObject({ available: true })
    expect(second).toMatchObject({ available: true })
    expect(spawnDaemon).toHaveBeenCalledTimes(1)
  })
})

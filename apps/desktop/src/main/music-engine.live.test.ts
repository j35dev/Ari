import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MusicEngine } from './music-engine'
import { MusicRuntime } from './music-runtime'

const execFileP = promisify(execFile)

// Live end-to-end: real manifest, real download, real YouTube. Gated behind
// ARI_MUSIC_LIVE=1 so `pnpm verify` stays hermetic; run on demand with:
//   ARI_MUSIC_LIVE=1 pnpm --filter @ari/desktop exec vitest run src/main/music-engine.live.test.ts
describe.runIf(process.env['ARI_MUSIC_LIVE'] === '1')('music live e2e', () => {
  it('downloads the helper and resolves a track plus stream URL', async () => {
    const userData = join(tmpdir(), 'ari-music-live')
    const appPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const env = {
      resourcesPath: '',
      appPath,
      userDataPath: userData,
    }
    const runtime = new MusicRuntime(env)
    const binary = await runtime.ensure()
    expect(binary).not.toBeNull()
    const { stdout: version } = await execFileP(binary as string, ['--version'], { timeout: 30_000 })
    expect(version).toContain('2026.08.19')

    const engine = new MusicEngine({ env, runtime })
    const resolved = await engine.resolveUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
    expect(resolved.kind).toBe('track')
    if (resolved.kind === 'track') {
      expect(resolved.track.title.length).toBeGreaterThan(0)
      const stream = await engine.streamTrack(resolved.track.id)
      expect(stream.url?.startsWith('https://')).toBe(true)
    }
  }, 180_000)
})

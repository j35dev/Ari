/** Windows native smoke check: modifies only this test's silent playback stream. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { windowsOutputBackend } from './audio-ducking-windows'
import { DuckingState, type DuckedVolume, type OutputSession } from './audio-ducking-state'

if (process.platform !== 'win32') throw new Error('This native smoke check requires Windows')
const directory = await mkdtemp(join(tmpdir(), 'ari-ducking-'))
const wavPath = join(directory, 'silence.wav')
const pcmSize = 16_000 * 2 * 2
const wav = Buffer.alloc(44 + pcmSize)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + pcmSize, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16_000, 24)
wav.writeUInt32LE(32_000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(pcmSize, 40)
await writeFile(wavPath, wav)
const quotedPath = `'${wavPath.replaceAll("'", "''")}'`
const script = `$player = [System.Media.SoundPlayer]::new(${quotedPath}); try { $player.PlayLooping(); [Console]::ReadLine() | Out-Null } finally { $player.Stop() }`
const playback = spawn(
  'powershell.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
)
const backend = windowsOutputBackend(() => new Set([process.pid]))
let held: OutputSession | undefined
let original: number[] | undefined
try {
  for (let attempt = 0; attempt < 40 && !held; attempt++) {
    const inventory = await backend.list()
    for (const session of inventory.sessions) {
      if (!held && session.pid === playback.pid) held = session
      else session.release()
    }
    if (!held) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(held, 'The silent playback process did not create an audio session')
  original = await held.read()
  await held.write([0.6])
  let saved: DuckedVolume[] = []
  const state = new DuckingState(
    {
      list: () => Promise.resolve({ sessions: [{ ...held!, release() {} }], complete: true }),
      dispose() {},
    },
    {
      read: () => Promise.resolve(saved),
      write: (entries) => {
        saved = structuredClone(entries)
        return Promise.resolve()
      },
    },
    (error) => {
      throw error
    },
  )
  await state.setActive(true)
  assert.ok(Math.abs((await held.read())[0]! - 0.15) < 0.0001)
  await state.setActive(true)
  assert.ok(Math.abs((await held.read())[0]! - 0.15) < 0.0001)
  await state.setActive(false)
  assert.ok(Math.abs((await held.read())[0]! - 0.6) < 0.0001)
  assert.equal(saved.length, 0)
  console.log(
    'Windows native check passed: silent test stream 0.60 → 0.15 → 0.60; duplicate activation did not compound.',
  )
} finally {
  if (held) {
    try {
      if (original) await held.write(original)
    } finally {
      held.release()
    }
  }
  backend.dispose()
  playback.stdin.end('\n')
  await new Promise<void>((resolve) => {
    if (playback.exitCode !== null) resolve()
    else playback.once('exit', () => resolve())
  })
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('ari-ducking-'))
  await rm(directory, { recursive: true, force: true })
}

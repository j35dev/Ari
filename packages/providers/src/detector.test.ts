import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findBinary, readAuthStatus, wellKnownDirs } from './detector'
import type { DetectEnvironment } from './types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-detector-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeEnv(overrides: Partial<DetectEnvironment> = {}): DetectEnvironment {
  return {
    platform: process.platform,
    pathEnv: '',
    homeDir: join(dir, 'home'),
    ...overrides,
  }
}

describe('findBinary', () => {
  it('resolves a binary on PATH honoring extension priority', async () => {
    const binDir = join(dir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFileSafe(join(binDir, 'claude'), '')
    const env: DetectEnvironment = { ...makeEnv(), pathEnv: binDir }
    expect(findBinary('claude', env)).toBe(join(binDir, 'claude'))
  })

  it('searches well-known dirs when PATH misses', async () => {
    const install = join(dir, 'localappdata', 'Programs')
    await mkdir(install, { recursive: true })
    await writeFileSafe(join(install, 'codex.cmd'), '')
    const env: DetectEnvironment = {
      ...makeEnv(),
      platform: 'win32',
      localAppData: join(dir, 'localappdata'),
    }
    // PATH points at an empty dir so the well-known dir wins.
    const empty = join(dir, 'empty')
    await mkdir(empty, { recursive: true })
    const withPath: DetectEnvironment = { ...env, pathEnv: empty }
    expect(findBinary('codex', withPath)).toBe(join(install, 'codex.cmd'))
  })

  it('returns null for missing binaries and for ari-core', () => {
    expect(findBinary('hermes', makeEnv())).toBeNull()
    expect(findBinary('ari-core', makeEnv())).toBeNull()
  })

  it('skips nonexistent well-known dirs without throwing', () => {
    const env: DetectEnvironment = { ...makeEnv(), homeDir: join(dir, 'nope') }
    const dirs = wellKnownDirs({ ...env, platform: 'linux' })
    // Host bin dirs (/usr/bin, /usr/local/bin) exist on CI; the missing
    // home-relative path must still be omitted, and the scan must not throw.
    expect(dirs).not.toContain(join(env.homeDir, '.local', 'bin'))
  })
})

describe('readAuthStatus', () => {
  it('detects codex auth.json presence', async () => {
    const home = join(dir, 'home2')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFileSafe(join(home, '.codex', 'auth.json'), '{"tokens":{}}')
    expect(readAuthStatus('codex', { ...makeEnv(), homeDir: home })).toBe('authenticated')
    expect(readAuthStatus('codex', { ...makeEnv(), homeDir: join(dir, 'none') })).toBe(
      'unauthenticated',
    )
  })

  it('detects claude credential files', async () => {
    const home = join(dir, 'home3')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFileSafe(join(home, '.claude', '.credentials.json'), '{}')
    expect(readAuthStatus('claude', { ...makeEnv(), homeDir: home })).toBe('authenticated')
  })

  it('returns unknown for drivers without confirmed layouts yet', () => {
    expect(readAuthStatus('grok', makeEnv())).toBe('unknown')
    expect(readAuthStatus('pi', makeEnv())).toBe('unknown')
    expect(readAuthStatus('hermes', makeEnv())).toBe('unknown')
  })
})

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, 'utf8')
}



import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findBinary, detectDriver, readAuthStatus, wellKnownDirs } from './detector'
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
    expect(readAuthStatus('codex', { ...makeEnv(), homeDir: home }).status).toBe('authenticated')
    expect(readAuthStatus('codex', { ...makeEnv(), homeDir: join(dir, 'none') }).status).toBe(
      'unauthenticated',
    )
  })

  it('detects claude credential files', async () => {
    const home = join(dir, 'home3')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFileSafe(join(home, '.claude', '.credentials.json'), '{}')
    expect(readAuthStatus('claude', { ...makeEnv(), homeDir: home }).status).toBe('authenticated')
  })

  it('detects grok auth.json and config.toml', async () => {
    const home = join(dir, 'grok-auth')
    await mkdir(join(home, '.grok'), { recursive: true })
    await writeFileSafe(join(home, '.grok', 'auth.json'), '{}')
    expect(readAuthStatus('grok', { ...makeEnv(), homeDir: home }).status).toBe('authenticated')

    const tomlHome = join(dir, 'grok-toml')
    await mkdir(join(tomlHome, '.grok'), { recursive: true })
    await writeFileSafe(join(tomlHome, '.grok', 'config.toml'), '')
    expect(readAuthStatus('grok', { ...makeEnv(), homeDir: tomlHome }).status).toBe('authenticated')
  })

  it('accepts XAI_API_KEY for grok without any file', () => {
    const env = { ...makeEnv(), homeDir: join(dir, 'nowhere'), vars: { XAI_API_KEY: 'x' } }
    expect(readAuthStatus('grok', env).status).toBe('authenticated')
    expect(readAuthStatus('grok', { ...env, vars: { XAI_API_KEY: '' } }).status).toBe('unknown')
  })

  it('detects pi auth.json under the default agent dir', async () => {
    const home = join(dir, 'pi-home')
    await mkdir(join(home, '.pi', 'agent'), { recursive: true })
    await writeFileSafe(join(home, '.pi', 'agent', 'auth.json'), '{}')
    expect(readAuthStatus('pi', { ...makeEnv(), homeDir: home }).status).toBe('authenticated')
  })

  it('honors PI_CODING_AGENT_DIR over the default pi dir', async () => {
    const custom = join(dir, 'pi-custom')
    await mkdir(custom, { recursive: true })
    await writeFileSafe(join(custom, 'auth.json'), '{}')
    const home = join(dir, 'pi-empty')
    await mkdir(join(home, '.pi', 'agent'), { recursive: true })
    const env = { ...makeEnv(), homeDir: home, vars: { PI_CODING_AGENT_DIR: custom } }
    expect(readAuthStatus('pi', env).status).toBe('authenticated')
    // Override points elsewhere: the default location is not consulted.
    await writeFileSafe(join(home, '.pi', 'agent', 'auth.json'), '{}')
    const missing = { ...env, vars: { PI_CODING_AGENT_DIR: join(dir, 'pi-void') } }
    expect(readAuthStatus('pi', missing).status).toBe('unknown')
  })

  it('resolves hermes auth per platform and honors HERMES_HOME', async () => {
    const localAppData = join(dir, 'lad')
    await mkdir(join(localAppData, 'hermes'), { recursive: true })
    await writeFileSafe(join(localAppData, 'hermes', 'auth.json'), '{}')
    expect(
      readAuthStatus('hermes', { ...makeEnv(), platform: 'win32', localAppData }).status,
    ).toBe('authenticated')

    const posixHome = join(dir, 'hermes-posix')
    await mkdir(join(posixHome, '.hermes'), { recursive: true })
    await writeFileSafe(join(posixHome, '.hermes', 'auth.json'), '{}')
    expect(
      readAuthStatus('hermes', { ...makeEnv(), platform: 'linux', homeDir: posixHome }).status,
    ).toBe('authenticated')

    const override = join(dir, 'hermes-override')
    await mkdir(override, { recursive: true })
    await writeFileSafe(join(override, 'auth.json'), '{}')
    expect(
      readAuthStatus('hermes', {
        ...makeEnv(),
        platform: 'linux',
        homeDir: join(dir, 'no-home'),
        vars: { HERMES_HOME: override },
      }).status,
    ).toBe('authenticated')
  })

  it('returns unknown with an honest reason when nothing resolves', () => {
    for (const kind of ['grok', 'pi', 'hermes'] as const) {
      const probe = readAuthStatus(kind, { ...makeEnv(), homeDir: join(dir, 'void') })
      expect(probe.status).toBe('unknown')
      expect(probe.reason).toBeTruthy()
    }
  })
})

describe('detectDriver', () => {
  it('reports a missing binary as not installed and never unauthenticated', async () => {
    const empty = join(dir, 'empty-path')
    await mkdir(empty, { recursive: true })
    const detection = await detectDriver('hermes', { ...makeEnv(), pathEnv: empty })
    expect(detection.installed).toBe(false)
    expect(detection.binaryPath).toBeNull()
    expect(detection.authStatus).toBe('unknown')
    expect(detection.authStatus).not.toBe('unauthenticated')
    expect(detection.authReason).toBeTruthy()
  })

  it('treats ari-core as installed and authenticated', async () => {
    const detection = await detectDriver('ari-core', makeEnv())
    expect(detection.installed).toBe(true)
    expect(detection.authStatus).toBe('authenticated')
  })
})

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, 'utf8')
}



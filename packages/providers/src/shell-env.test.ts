import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  loginShellPath,
  processEnvWithPath,
  resolveDetectionEnvironment,
  versionManagerDirs,
} from './shell-env'
import type { DetectEnvironment } from './types'

afterEach(() => {
  vi.unstubAllEnvs()
})

function makeEnv(overrides: Partial<DetectEnvironment> = {}): DetectEnvironment {
  return {
    platform: 'linux',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/home/tester',
    localAppData: '',
    appData: '',
    ...overrides,
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'ari-shell-env-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('versionManagerDirs', () => {
  it('returns only directories that exist', () => {
    vi.stubEnv('PNPM_HOME', '')
    const home = join(scratch, 'vm-home')
    mkdirSync(join(home, '.volta', 'bin'), { recursive: true })
    const dirs = versionManagerDirs(makeEnv({ homeDir: home }))
    expect(dirs).toEqual([join(home, '.volta', 'bin')])
  })

  it('picks the newest nvm version and orders managers deterministically', () => {
    const home = join(scratch, 'nvm-home')
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v18.19.0', 'bin'), { recursive: true })
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v22.4.1', 'bin'), { recursive: true })
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true })
    const dirs = versionManagerDirs(makeEnv({ homeDir: home }))
    expect(dirs[0]).toBe(join(home, '.bun', 'bin'))
    expect(dirs).toContain(join(home, '.nvm', 'versions', 'node', 'v22.4.1', 'bin'))
    expect(dirs).not.toContain(join(home, '.nvm', 'versions', 'node', 'v18.19.0', 'bin'))
  })

  it('covers windows npm/manager shim dirs when they exist', () => {
    const root = join(scratch, 'win')
    const appData = join(root, 'Roaming')
    const localAppData = join(root, 'Local')
    mkdirSync(join(appData, 'npm'), { recursive: true })
    mkdirSync(join(localAppData, 'Volta', 'bin'), { recursive: true })
    const dirs = versionManagerDirs(
      makeEnv({ platform: 'win32', homeDir: join(root, 'home'), appData, localAppData }),
    )
    expect(dirs).toContain(join(appData, 'npm'))
    expect(dirs).toContain(join(localAppData, 'Volta', 'bin'))
  })

  it('returns empty for a bare environment', () => {
    vi.stubEnv('PNPM_HOME', '')
    vi.stubEnv('FNM_DIR', '')
    expect(versionManagerDirs(makeEnv({ homeDir: join(scratch, 'missing') }))).toEqual([])
  })
})

describe('loginShellPath', () => {
  it('is a no-op on Windows or under the opt-out flag', async () => {
    if (process.platform === 'win32' || process.env['ARI_NO_LOGIN_SHELL'] === '1') {
      expect(await loginShellPath(100)).toBeNull()
    } else {
      // POSIX with a real shell configured resolves (or null without SHELL);
      // either way it must settle well within CI budgets.
      const value = await loginShellPath(4000)
      expect(value === null || value.length > 0).toBe(true)
    }
  }, 10_000)
})

describe('resolveDetectionEnvironment', () => {
  it('keeps process PATH first and appends version-manager dirs deduped', async () => {
    const home = join(scratch, 'merge-home')
    const volta = join(home, '.volta', 'bin')
    mkdirSync(volta, { recursive: true })
    const env = await resolveDetectionEnvironment(
      makeEnv({ pathEnv: `/usr/bin${delimiter}${volta}`, homeDir: home }),
    )
    const entries = env.pathEnv.split(delimiter)
    expect(entries.indexOf('/usr/bin')).toBeLessThan(entries.indexOf(volta))
    expect(entries.filter((e) => e === volta)).toHaveLength(1)
  })

  it('preserves every original process PATH entry', async () => {
    const original = ['/a', '/b', '/c'].join(delimiter)
    const env = await resolveDetectionEnvironment(makeEnv({ pathEnv: original }))
    const entries = env.pathEnv.split(delimiter)
    for (const part of ['/a', '/b', '/c']) {
      expect(entries).toContain(part)
    }
  })
})

describe('processEnvWithPath', () => {
  it('overlays PATH onto a copy of the base env', () => {
    const next = processEnvWithPath('/custom/bin', { HOME: '/home/t', PATH: '/usr/bin' })
    expect(next.PATH).toBe('/custom/bin')
    expect(next.HOME).toBe('/home/t')
  })
})

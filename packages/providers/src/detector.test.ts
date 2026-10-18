import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkBinaryPath,
  detectDriver,
  findBinaries,
  findBinary,
  readAuthStatus,
  wellKnownDirs,
} from './detector'
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
    // Pinned to posix: on win32 the bare name is not a runnable candidate at
    // all, which the cases below cover.
    const env: DetectEnvironment = { ...makeEnv(), platform: 'linux', pathEnv: binDir }
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

  it('prefers runnable .exe/.cmd over the extensionless npm shim on win32', async () => {
    const npmDir = join(dir, 'npm')
    await mkdir(npmDir, { recursive: true })
    await writeFileSafe(join(npmDir, 'opencode'), '')
    await writeFileSafe(join(npmDir, 'opencode.cmd'), '')
    const env: DetectEnvironment = { ...makeEnv(), pathEnv: npmDir }
    expect(findBinary('opencode', { ...env, platform: 'win32' })).toBe(join(npmDir, 'opencode.cmd'))
    await writeFileSafe(join(npmDir, 'opencode.exe'), '')
    expect(findBinary('opencode', { ...env, platform: 'win32' })).toBe(join(npmDir, 'opencode.exe'))
    expect(findBinary('opencode', { ...env, platform: 'linux' })).toBe(join(npmDir, 'opencode'))
  })

  it('skips a bare shim in an earlier PATH entry for a runnable one later', async () => {
    // The scan is directory-first, so ranking extensions inside a directory is
    // not enough: an unrunnable bare shim earlier on PATH would end the search
    // before the .cmd that actually works is ever reached.
    const stale = join(dir, 'stale')
    const npmDir = join(dir, 'npm-later')
    await mkdir(stale, { recursive: true })
    await mkdir(npmDir, { recursive: true })
    await writeFileSafe(join(stale, 'opencode'), '')
    await writeFileSafe(join(npmDir, 'opencode.cmd'), '')
    const env: DetectEnvironment = {
      ...makeEnv(),
      platform: 'win32',
      pathEnv: [stale, npmDir].join(delimiter),
    }
    expect(findBinary('opencode', env)).toBe(join(npmDir, 'opencode.cmd'))
  })

  it('finds nothing on win32 when only the bare shim exists', async () => {
    // Honest over hopeful: reporting a path Windows cannot spawn produced a
    // provider that looked installed and failed on use.
    const npmDir = join(dir, 'bare-only')
    await mkdir(npmDir, { recursive: true })
    await writeFileSafe(join(npmDir, 'opencode'), '')
    expect(findBinary('opencode', { ...makeEnv(), platform: 'win32', pathEnv: npmDir })).toBeNull()
  })

  it('returns null for missing binaries and for ari-core', () => {
    expect(findBinary('hermes', makeEnv())).toBeNull()
    expect(findBinary('ari-core', makeEnv())).toBeNull()
  })

  it('ignores a directory named like the binary', async () => {
    // A project folder called `codex` on PATH used to be reported as an
    // installed CLI, which put a fully-populated Codex rail in the picker.
    const binDir = join(dir, 'phantom')
    await mkdir(join(binDir, 'codex'), { recursive: true })
    expect(findBinary('codex', { ...makeEnv(), pathEnv: binDir })).toBeNull()
  })

  it('prefers a real file over a same-named directory earlier on PATH', async () => {
    const early = join(dir, 'early')
    const later = join(dir, 'later')
    await mkdir(join(early, 'codex'), { recursive: true })
    await mkdir(later, { recursive: true })
    await writeFileSafe(join(later, 'codex'), '')
    // Pinned to posix: on win32 the bare name is not a runnable candidate.
    const env: DetectEnvironment = {
      ...makeEnv(),
      platform: 'linux',
      pathEnv: [early, later].join(delimiter),
    }
    expect(findBinary('codex', env)).toBe(join(later, 'codex'))
  })

  it('skips a PATH entry that cannot be read rather than aborting the scan', async () => {
    // A PATH entry that is a file, not a directory: resolving a candidate
    // under it raises ENOTDIR instead of reporting that candidate missing,
    // so one unusable entry used to abort detection before the directories
    // after it were searched — hiding a provider that is installed.
    const notADir = join(dir, 'not-a-dir')
    await writeFileSafe(notADir, '')
    const later = join(dir, 'later-readable')
    await mkdir(later, { recursive: true })
    await writeFileSafe(join(later, 'codex'), '')
    // Pinned to posix so the later candidate is the bare name this case writes.
    const env: DetectEnvironment = {
      ...makeEnv(),
      platform: 'linux',
      pathEnv: [notADir, later].join(delimiter),
    }
    expect(findBinary('codex', env)).toBe(join(later, 'codex'))
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

  it('does not report a directory named like a binary as installed', async () => {
    const binDir = join(dir, 'phantom-driver')
    await mkdir(join(binDir, 'codex'), { recursive: true })
    const detection = await detectDriver('codex', { ...makeEnv(), pathEnv: binDir })
    expect(detection.installed).toBe(false)
    expect(detection.binaryPath).toBeNull()
    expect(detection.authStatus).toBe('unknown')
  })

  it('treats ari-core as installed and authenticated', async () => {
    const detection = await detectDriver('ari-core', makeEnv())
    expect(detection.installed).toBe(true)
    expect(detection.authStatus).toBe('authenticated')
  })

  it('reports a provider that is turned off as absent without running it', async () => {
    const binDir = join(dir, 'off')
    await mkdir(binDir, { recursive: true })
    // Leaves a file behind if anything starts it.
    const ran = join(binDir, 'ran.txt')
    await writeExecutable(
      join(binDir, cliName('codex')),
      process.platform === 'win32'
        ? '@echo ran > "%~dp0ran.txt"'
        : '#!/bin/sh\necho ran > "$(dirname "$0")/ran.txt"\n',
    )
    const detection = await detectDriver(
      'codex',
      { ...makeEnv(), pathEnv: binDir },
      { enabled: false },
    )
    expect(detection).toMatchObject({
      enabled: false,
      installed: false,
      binaryPath: null,
      version: null,
      authStatus: 'unknown',
    })
    // Still listed, so the settings page can show where it is.
    expect(detection.candidates?.[0]).toBe(join(binDir, cliName('codex')))
    expect(existsSync(ran)).toBe(false)

    // The same file does run once the provider is on, so the check above means something.
    await detectDriver('codex', { ...makeEnv(), pathEnv: binDir })
    expect(existsSync(ran)).toBe(true)
  })

  it('uses the path the user chose over the one on PATH', async () => {
    const onPath = join(dir, 'on-path')
    const chosen = join(dir, 'chosen')
    await mkdir(onPath, { recursive: true })
    await mkdir(chosen, { recursive: true })
    await writeFileSafe(join(onPath, cliName('grok')), '')
    await writeExecutable(join(chosen, cliName('grok')))
    const detection = await detectDriver(
      'grok',
      { ...makeEnv(), pathEnv: onPath },
      { binaryPath: join(chosen, cliName('grok')) },
    )
    expect(detection).toMatchObject({
      enabled: true,
      installed: true,
      binaryPath: join(chosen, cliName('grok')),
      pathSource: 'custom',
    })
    expect(detection.candidates?.[0]).toBe(join(onPath, cliName('grok')))
    // An empty file answers nothing, which is worth saying about a chosen path.
    expect(detection.pathProblem).toMatch(/--version/)
  })

  it('refuses a chosen path that is wrong instead of falling back to PATH', async () => {
    const onPath = join(dir, 'fallback')
    await mkdir(onPath, { recursive: true })
    await writeFileSafe(join(onPath, cliName('claude')), '')
    const detection = await detectDriver(
      'claude',
      { ...makeEnv(), pathEnv: onPath },
      { binaryPath: join(dir, 'gone', cliName('claude')) },
    )
    expect(detection).toMatchObject({
      enabled: true,
      installed: false,
      binaryPath: null,
      pathSource: 'custom',
      pathProblem: 'No file exists at this path.',
    })
    expect(detection.candidates?.[0]).toBe(join(onPath, cliName('claude')))
  })

  it('marks a PATH result as found automatically', async () => {
    const binDir = join(dir, 'auto')
    await mkdir(binDir, { recursive: true })
    await writeFileSafe(join(binDir, cliName('pi')), '')
    const detection = await detectDriver('pi', { ...makeEnv(), pathEnv: binDir })
    expect(detection.pathSource).toBe('auto')
    expect(detection.pathProblem).toBeUndefined()
  })
})

describe('findBinaries', () => {
  it('lists every install in search order, one per directory', async () => {
    const native = join(dir, 'native')
    const npm = join(dir, 'npm')
    await mkdir(native, { recursive: true })
    await mkdir(npm, { recursive: true })
    await writeFileSafe(join(native, 'claude.exe'), '')
    await writeFileSafe(join(npm, 'claude.cmd'), '')
    await writeFileSafe(join(npm, 'claude.exe'), '')
    await writeFileSafe(join(npm, 'claude'), '')
    const env: DetectEnvironment = {
      ...makeEnv(),
      platform: 'win32',
      // Directories repeated, as real PATHs often have them. The second visit
      // to `npm` must not list the `.cmd` beside the `.exe` already found.
      pathEnv: [native, npm, native, npm, `${npm}${sep}`].join(delimiter),
    }
    expect(findBinaries('claude', env)).toEqual([join(native, 'claude.exe'), join(npm, 'claude.exe')])
    expect(findBinary('claude', env)).toBe(join(native, 'claude.exe'))
  })

  it('finds nothing for ari-core, which has no binary', () => {
    expect(findBinaries('ari-core', makeEnv())).toEqual([])
  })
})

describe('checkBinaryPath', () => {
  it('accepts an existing runnable file and strips pasted quotes', async () => {
    const file = join(dir, cliName('codex'))
    await writeExecutable(file)
    expect(checkBinaryPath(`"${file}"`, makeEnv())).toEqual({ ok: true, value: file })
    expect(checkBinaryPath(`  ${file}  `, makeEnv())).toEqual({ ok: true, value: file })
  })

  it('expands a leading ~ to the home directory', async () => {
    const home = join(dir, 'home')
    await mkdir(join(home, 'bin'), { recursive: true })
    await writeExecutable(join(home, 'bin', cliName('pi')))
    const expected = join(home, 'bin', cliName('pi'))
    expect(checkBinaryPath(`~/bin/${cliName('pi')}`, makeEnv())).toEqual({ ok: true, value: expected })
  })

  it('says what is wrong with a path it will not use', async () => {
    const folder = join(dir, 'a-folder')
    await mkdir(folder, { recursive: true })
    const reasonFor = (path: string): string => {
      const check = checkBinaryPath(path, makeEnv())
      return check.ok ? 'accepted' : check.error
    }
    expect(reasonFor('claude')).toBe('Enter the full path to the executable.')
    expect(reasonFor(join(dir, 'missing', cliName('claude')))).toBe('No file exists at this path.')
    expect(reasonFor(folder)).toBe('This is a folder. Choose the executable inside it.')
  })

  // The bare npm shim beside `claude.cmd` is the file a user is most likely to
  // pick by mistake. Needs a real Windows path to get past the absolute check.
  it.skipIf(process.platform !== 'win32')('rejects a file Windows cannot launch', async () => {
    const shim = join(dir, 'claude')
    await writeFileSafe(shim, '#!/bin/sh')
    expect(checkBinaryPath(shim, makeEnv())).toEqual({
      ok: false,
      error: 'Windows cannot run this file. Choose the .exe or .cmd version.',
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a file without the execute bit', async () => {
    const file = join(dir, 'plain')
    await writeFileSafe(file, '')
    expect(checkBinaryPath(file, makeEnv())).toEqual({
      ok: false,
      error: 'This file is not executable.',
    })
  })
})

/** The name a CLI has on this platform; bare names are not runnable on Windows. */
function cliName(kind: string): string {
  return process.platform === 'win32' ? `${kind}.cmd` : kind
}

async function writeExecutable(path: string, content = ''): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, { encoding: 'utf8', mode: 0o755 })
}

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, 'utf8')
}



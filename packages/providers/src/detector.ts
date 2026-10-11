import { accessSync, constants, existsSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { delimiter, join, posix, win32 } from 'node:path'
import { spawn } from 'node:child_process'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { err, ok } from '@ari/shared/result'
import type { Result } from '@ari/shared/result'
import { realDetectEnvironment } from './types'
import type { AuthProbe, DetectEnvironment, Detection } from './types'
import { needsWindowsShell, buildCmdSpawnArgs } from './spawn-cli'

const log = createLogger('providers:detector')

/** CLI binary names to search for, in priority order. */
const BINARY_NAMES: Record<DriverKind, string[]> = {
  claude: ['claude', 'claude.cmd', 'claude.exe'],
  codex: ['codex', 'codex.cmd', 'codex.exe'],
  opencode: ['opencode', 'opencode.cmd', 'opencode.exe'],
  grok: ['grok', 'grok.cmd', 'grok.exe'],
  pi: ['pi', 'pi.cmd', 'pi.exe'],
  hermes: ['hermes', 'hermes.cmd', 'hermes.exe'],
  'ari-core': [],
}

/**
 * Extra well-known install locations beyond PATH (PLAN §8). Only existing
 * directories are searched; missing ones are skipped silently.
 */
export function wellKnownDirs(env: DetectEnvironment): string[] {
  const dirs: string[] = []
  if (env.platform === 'win32') {
    if (env.localAppData) {
      dirs.push(
        join(env.localAppData, 'Programs'),
        join(env.localAppData, 'Programs', 'npm'),
      )
    }
  } else {
    dirs.push(
      join(env.homeDir, '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
    )
  }
  return dirs.filter((d) => d.length > 0 && existsSync(d))
}

/** True when `path` names a regular file — not a directory, socket, or link to one. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    // `throwIfNoEntry: false` only covers a missing entry. An unusable one —
    // a path through a file, a directory that denies traversal — still
    // throws, and letting that escape aborted the whole scan instead of
    // moving on to the directories after it.
    return false
  }
}

/** Resolves a binary across PATH plus platform-specific install dirs. */
export function findBinary(kind: DriverKind, env: DetectEnvironment): string | null {
  return findBinaries(kind, env)[0] ?? null
}

/**
 * Every install of a CLI the search finds, the one Ari would use first. A
 * machine often holds two (a native installer's and an npm shim), and which
 * one wins depends on PATH order the user never chose.
 */
export function findBinaries(kind: DriverKind, env: DetectEnvironment): string[] {
  if (kind === 'ari-core') return []
  // npm drops an extensionless sh shim next to the .cmd one, and Windows cannot
  // spawn it (ENOENT). Dropping those candidates outright, rather than merely
  // ranking them last, is what matters: the search is directory-first, so a
  // bare shim in an earlier PATH entry would still beat a runnable .cmd in a
  // later one. Nothing is lost — a Windows executable needs its extension.
  const names =
    env.platform === 'win32'
      ? BINARY_NAMES[kind].filter((name) => /\.(?:exe|cmd)$/i.test(name)).reverse()
      : BINARY_NAMES[kind]
  const searchDirs = [
    ...env.pathEnv.split(delimiter).filter((p) => p.length > 0),
    ...wellKnownDirs(env),
  ]
  const found: string[] = []
  const searched = new Set<string>()
  for (const dir of searchDirs) {
    // PATH often names a directory twice (user and system halves overlap).
    const trimmed = dir.replace(/(?<=.)[\\/]+$/, '')
    const key = env.platform === 'win32' ? trimmed.toLowerCase() : trimmed
    if (searched.has(key)) continue
    searched.add(key)
    for (const name of names) {
      const candidate = join(dir, name)
      // isFile, not existsSync: a *directory* named `codex` (a checked-out
      // repo, a scratch folder) is not a CLI, and treating it as one put a
      // fully-populated provider row in front of users who never installed it.
      if (!isRegularFile(candidate)) continue
      found.push(candidate)
      // One per directory: a `.exe` beside its own `.cmd` is the same install.
      break
    }
  }
  return found
}

/**
 * Vets a CLI path the user typed before anything is launched from it. Says
 * what is wrong in terms the user can act on, since the alternative is a
 * provider that looks configured and fails on its first turn.
 */
export function checkBinaryPath(raw: string, env: DetectEnvironment): Result<string, string> {
  const unquoted = raw.trim().replace(/^(["'])(.*)\1$/, '$2')
  const path = /^~(?=$|[\\/])/.test(unquoted) ? join(env.homeDir, unquoted.slice(1)) : unquoted
  const paths = env.platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(path)) {
    return err('Enter the full path to the executable.')
  }
  let stats: Stats | undefined
  try {
    stats = statSync(path, { throwIfNoEntry: false })
  } catch {
    stats = undefined
  }
  if (stats === undefined) return err('No file exists at this path.')
  if (stats.isDirectory()) {
    return err('This is a folder. Choose the executable inside it.')
  }
  if (!stats.isFile()) return err('This path is not a file.')
  if (env.platform === 'win32') {
    if (!/\.(?:exe|com|cmd|bat)$/i.test(path)) {
      return err('Windows cannot run this file. Choose the .exe or .cmd version.')
    }
  } else {
    try {
      accessSync(path, constants.X_OK)
    } catch {
      return err('This file is not executable.')
    }
  }
  return ok(path)
}

/**
 * Probes `<binary> --version`. On Windows, .cmd shims are executed through an
 * escaped cmd.exe wrapper (direct spawn is refused with EINVAL on Node ≥20).
 */
// Large single-file CLIs (opencode.exe is ~180 MB) can take >5s to answer when
// every provider is probed concurrently at startup, so allow a generous window.
function probeVersion(binaryPath: string, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (value: string | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    const child = needsWindowsShell(binaryPath)
      ? (() => {
          const wrapped = buildCmdSpawnArgs(binaryPath, ['--version'])
          const c = spawn(wrapped.file, wrapped.args, {
            windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: timeoutMs,
          })
          c.on('error', () => done(null))
          return c
        })()
      : spawn(binaryPath, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: timeoutMs,
        }).on('error', () => done(null))
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      if (code !== 0 && stdout.length === 0) {
        log.debug('version probe failed', { binaryPath, code })
        done(null)
        return
      }
      const firstLine = stdout.split('\n')[0]?.trim()
      done(firstLine ? firstLine : null)
    })
    setTimeout(() => {
      if (!settled) {
        child.kill()
        done(null)
      }
    }, timeoutMs + 1000).unref?.()
  })
}

/** Reads one env var from the injected map, treating '' as unset. */
function envVar(env: DetectEnvironment, name: string): string | null {
  const raw = env.vars?.[name]
  return raw != null && raw.length > 0 ? raw : null
}

const authenticated: AuthProbe = { status: 'authenticated' }
const unauthenticated: AuthProbe = { status: 'unauthenticated' }

function unknownAuth(reason: string): AuthProbe {
  return { status: 'unknown', reason }
}

/**
 * Credential-store locations per kind. Existence only — Ari never opens these
 * files, never writes them, and never logs their contents.
 */
function authCandidates(kind: DriverKind, env: DetectEnvironment): string[] {
  switch (kind) {
    case 'claude':
      return [join(env.homeDir, '.claude', '.credentials.json'), join(env.homeDir, '.claude.json')]
    case 'codex':
      // Codex auths either via auth.json (ChatGPT/OpenAI login) or via a
      // config.toml provider block (custom routers/API keys).
      return [join(env.homeDir, '.codex', 'auth.json'), join(env.homeDir, '.codex', 'config.toml')]
    case 'opencode':
      return env.platform === 'win32' && env.localAppData
        ? [join(env.localAppData, 'opencode', 'auth.json')]
        : [
            join(env.homeDir, '.local', 'share', 'opencode', 'auth.json'),
            join(env.homeDir, '.config', 'opencode', 'auth.json'),
          ]
    case 'grok':
      return [join(env.homeDir, '.grok', 'auth.json'), join(env.homeDir, '.grok', 'config.toml')]
    case 'pi': {
      // PI_CODING_AGENT_DIR relocates the whole agent dir, auth.json included.
      const agentDir = envVar(env, 'PI_CODING_AGENT_DIR') ?? join(env.homeDir, '.pi', 'agent')
      return [join(agentDir, 'auth.json')]
    }
    case 'hermes': {
      const home = envVar(env, 'HERMES_HOME')
      if (home) return [join(home, 'auth.json')]
      return env.platform === 'win32' && env.localAppData
        ? [join(env.localAppData, 'hermes', 'auth.json')]
        : [join(env.homeDir, '.hermes', 'auth.json')]
    }
    default:
      return []
  }
}

/**
 * Read-only auth probes against each CLI's own credential store (PLAN §4.1).
 * Ari never mutates these files and never performs OAuth itself. An `unknown`
 * verdict always carries a reason — it means "Ari cannot tell", not "logged
 * out", so a missing store is never reported as `unauthenticated` unless the
 * CLI has no other way to authenticate.
 */
export function readAuthStatus(kind: DriverKind, env: DetectEnvironment): AuthProbe {
  if (kind === 'ari-core') return authenticated
  if (kind === 'grok' && envVar(env, 'XAI_API_KEY') !== null) return authenticated
  const candidates = authCandidates(kind, env)
  if (candidates.some((c) => existsSync(c))) return authenticated
  switch (kind) {
    case 'codex':
      // Codex has no alternative credential source: neither file present means
      // `codex login` has genuinely never run.
      return unauthenticated
    case 'claude':
      return unknownAuth('No ~/.claude credentials file; Claude Code may be using a subscription session or ANTHROPIC_API_KEY.')
    case 'opencode':
      return unknownAuth('No opencode auth.json found; opencode can also read provider keys from the environment.')
    case 'grok':
      return unknownAuth('No ~/.grok/auth.json or config.toml and XAI_API_KEY is unset.')
    case 'pi':
      return unknownAuth('No auth.json under the pi agent dir (override with PI_CODING_AGENT_DIR).')
    case 'hermes':
      return unknownAuth('No hermes auth.json in the platform config dir (override with HERMES_HOME).')
    default:
      return unknownAuth('Ari has no credential-store layout for this CLI.')
  }
}

/** How the user configured one provider; absent fields mean on, and found on PATH. */
export interface DetectOptions {
  enabled?: boolean
  binaryPath?: string
}

export async function detectDriver(
  kind: DriverKind,
  env: DetectEnvironment = realDetectEnvironment(),
  options: DetectOptions = {},
): Promise<Detection> {
  if (kind === 'ari-core') {
    return {
      kind,
      installed: true,
      binaryPath: null,
      version: null,
      authStatus: 'authenticated',
    }
  }
  const candidates = findBinaries(kind, env)
  // Reported as absent rather than merely flagged, so nothing that reads a
  // detection can launch, probe or offer a provider the user turned off.
  const absent = { kind, installed: false, binaryPath: null, version: null, candidates } as const
  if (options.enabled === false) {
    return {
      ...absent,
      enabled: false,
      authStatus: 'unknown',
      authReason: 'Turned off in Settings.',
    }
  }
  const configured = options.binaryPath?.trim() ?? ''
  let binaryPath = candidates[0] ?? null
  if (configured.length > 0) {
    // A path that does not hold up is an error to show, never a reason to
    // quietly run a different install than the one the user named.
    const check = checkBinaryPath(configured, env)
    if (!check.ok) {
      return {
        ...absent,
        enabled: true,
        pathSource: 'custom',
        pathProblem: check.error,
        authStatus: 'unknown',
        authReason: 'Ari cannot check credentials until the CLI path is fixed.',
      }
    }
    binaryPath = check.value
  }
  if (!binaryPath) {
    // Install state and auth state are independent axes: with no binary there
    // is nothing to be logged out of, so the auth verdict is honestly unknown.
    return {
      ...absent,
      enabled: true,
      authStatus: 'unknown',
      authReason: 'Not installed - Ari cannot check credentials until the CLI is present.',
    }
  }
  const version = await probeVersion(binaryPath)
  const probe = readAuthStatus(kind, env)
  const custom = configured.length > 0
  return {
    kind,
    enabled: true,
    installed: true,
    binaryPath,
    version,
    candidates,
    pathSource: custom ? 'custom' : 'auto',
    ...(custom && version === null
      ? { pathProblem: 'This file did not answer --version, so it may not be the right CLI.' }
      : {}),
    authStatus: probe.status,
    ...(probe.reason === undefined ? {} : { authReason: probe.reason }),
  }
}

export async function detectAll(
  kinds: DriverKind[],
  env: DetectEnvironment = realDetectEnvironment(),
): Promise<Detection[]> {
  return Promise.all(kinds.map((kind) => detectDriver(kind, env)))
}

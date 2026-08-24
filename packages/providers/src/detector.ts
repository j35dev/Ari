import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
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

/** Resolves a binary across PATH plus platform-specific install dirs. */
export function findBinary(kind: DriverKind, env: DetectEnvironment): string | null {
  if (kind === 'ari-core') return null
  const names = BINARY_NAMES[kind]
  const searchDirs = [
    ...env.pathEnv.split(delimiter).filter((p) => p.length > 0),
    ...wellKnownDirs(env),
  ]
  for (const dir of searchDirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      // existsSync on a file also rejects directories named like the binary.
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Probes `<binary> --version`. On Windows, .cmd shims are executed through an
 * escaped cmd.exe wrapper (direct spawn is refused with EINVAL on Node ≥20).
 */
function probeVersion(binaryPath: string, timeoutMs = 5000): Promise<string | null> {
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

export async function detectDriver(
  kind: DriverKind,
  env: DetectEnvironment = realDetectEnvironment(),
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
  const binaryPath = findBinary(kind, env)
  if (!binaryPath) {
    // Install state and auth state are independent axes: with no binary there
    // is nothing to be logged out of, so the auth verdict is honestly unknown.
    return {
      kind,
      installed: false,
      binaryPath: null,
      version: null,
      authStatus: 'unknown',
      authReason: 'Not installed - Ari cannot check credentials until the CLI is present.',
    }
  }
  const version = await probeVersion(binaryPath)
  const probe = readAuthStatus(kind, env)
  return {
    kind,
    installed: true,
    binaryPath,
    version,
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

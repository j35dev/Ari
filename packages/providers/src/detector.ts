import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { realDetectEnvironment } from './types'
import type { AuthStatus, DetectEnvironment, Detection } from './types'
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

/**
 * Read-only auth probes against each CLI's own credential store (PLAN §4.1).
 * Ari never mutates these files and never performs OAuth itself.
 */
export function readAuthStatus(kind: DriverKind, env: DetectEnvironment): AuthStatus {
  switch (kind) {
    case 'claude': {
      const credFile = join(env.homeDir, '.claude', '.credentials.json')
      const legacyFile = join(env.homeDir, '.claude.json')
      if (existsSync(credFile) || existsSync(legacyFile)) return 'authenticated'
      return 'unknown'
    }
    case 'codex': {
      // Codex auths either via auth.json (ChatGPT/OpenAI login) or via a
      // config.toml provider block (custom routers/API keys). Presence of
      // either means the CLI is usable; only neither means unauthenticated.
      const authFile = join(env.homeDir, '.codex', 'auth.json')
      const configFile = join(env.homeDir, '.codex', 'config.toml')
      if (existsSync(authFile) || existsSync(configFile)) return 'authenticated'
      return 'unauthenticated'
    }
    case 'opencode': {
      const candidates =
        env.platform === 'win32' && env.localAppData
          ? [join(env.localAppData, 'opencode', 'auth.json')]
          : [
              join(env.homeDir, '.local', 'share', 'opencode', 'auth.json'),
              join(env.homeDir, '.config', 'opencode', 'auth.json'),
            ]
      if (candidates.some((c) => existsSync(c))) return 'authenticated'
      return 'unknown'
    }
    default:
      // grok / pi / hermes config layouts are confirmed during driver M-tasks.
      return 'unknown'
  }
}

export async function detectDriver(
  kind: DriverKind,
  env: DetectEnvironment = realDetectEnvironment(),
): Promise<Detection> {
  if (kind === 'ari-core') {
    return { kind, binaryPath: null, version: null, authStatus: 'authenticated' }
  }
  const binaryPath = findBinary(kind, env)
  if (!binaryPath) {
    return { kind, binaryPath: null, version: null, authStatus: 'unauthenticated' }
  }
  const version = await probeVersion(binaryPath)
  const authStatus = readAuthStatus(kind, env)
  return { kind, binaryPath, version, authStatus }
}

export async function detectAll(
  kinds: DriverKind[],
  env: DetectEnvironment = realDetectEnvironment(),
): Promise<Detection[]> {
  return Promise.all(kinds.map((kind) => detectDriver(kind, env)))
}

import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { DetectEnvironment } from '../types'

/**
 * Which OpenCode generation a binary is. Classic OpenCode (npm `opencode-ai`,
 * 1.x) prints a bare semver for `--version`; OpenCode 2 (npm `@opencode/cli`,
 * and the `@opencode-ai/cli` betas) prints `opencode v2.4.1` or
 * `opencode2 v0.0.0-beta-…`.
 */
export type OpencodeGeneration = 'v1' | 'v2'

export interface OpencodeVersion {
  generation: OpencodeGeneration
  /** The semver, without the program name or `v`. */
  version: string
  /** How the UI names it. */
  label: 'OpenCode' | 'OpenCode 2'
}

export function classifyOpencodeVersion(output: string | null | undefined): OpencodeVersion | null {
  const line = output?.trim().split(/\r?\n/)[0]?.trim() ?? ''
  const named = /^(opencode2?)\s+v?(\d+\.\d+\.\d+\S*)/i.exec(line)
  const bare = named === null ? /^v?(\d+\.\d+\.\d+\S*)$/.exec(line) : null
  const version = named?.[2] ?? bare?.[1]
  if (version === undefined) return null
  const major = Number(version.split('.')[0])
  const v2 =
    named?.[1]?.toLowerCase() === 'opencode2' ||
    major >= 2 ||
    // OpenCode 2 previews were published as 0.0.0-beta builds.
    (named !== null && major === 0)
  return v2
    ? { generation: 'v2', version, label: 'OpenCode 2' }
    : { generation: 'v1', version, label: 'OpenCode' }
}

const V2_NAMES_WIN = ['opencode2.exe', 'opencode2.cmd', 'opencode2.ps1']
const V2_NAMES_POSIX = ['opencode2']

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    return false
  }
}

/** npm's global prefix without running npm (a 1–2 s spawn on Windows). */
function npmPrefixes(env: DetectEnvironment): string[] {
  const configured = env.vars?.['npm_config_prefix'] ?? env.vars?.['NPM_CONFIG_PREFIX']
  const prefixes = configured ? [configured] : []
  if (env.platform === 'win32') {
    if (env.appData) prefixes.push(join(env.appData, 'npm'))
  } else {
    prefixes.push('/usr/local', '/opt/homebrew', join(env.homeDir, '.npm-global'))
  }
  return prefixes
}

/**
 * Every OpenCode 2 launcher that is not on PATH under the plain `opencode`
 * name: `opencode2` on PATH, in the npm global bin directory, and inside the
 * global package itself. npm leaves the `opencode2` shim out when an install
 * is interrupted, and the binary in the package still runs.
 */
export function findOpencode2Binaries(env: DetectEnvironment): string[] {
  const names = env.platform === 'win32' ? V2_NAMES_WIN : V2_NAMES_POSIX
  const dirs = env.pathEnv.split(delimiter).filter((dir) => dir.length > 0)
  for (const prefix of npmPrefixes(env)) {
    const modules =
      env.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
    dirs.push(
      env.platform === 'win32' ? prefix : join(prefix, 'bin'),
      join(modules, '@opencode', 'cli', 'bin'),
      join(modules, '@opencode-ai', 'cli', 'bin'),
    )
  }
  const found: string[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    const key = env.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    const hit = names.map((name) => join(dir, name)).find(isFile)
    if (hit !== undefined) found.push(hit)
  }
  return found
}

import { existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { createLogger } from '@ari/shared/logger'
import { realDetectEnvironment } from './types'
import type { DetectEnvironment } from './types'

const log = createLogger('providers:shell-env')

/**
 * Node version-manager install dirs (comet's `shell_env.rs` practice): CLIs
 * installed through fnm/volta/nvm/bun/pnpm live outside both the GUI
 * process PATH and the well-known system dirs. Only existing directories are
 * returned; ordering is newest/most-specific first.
 */
export function versionManagerDirs(env: DetectEnvironment): string[] {
  const dirs: string[] = []
  const add = (dir: string): void => {
    if (dir.length > 0 && !dirs.includes(dir)) dirs.push(dir)
  }
  if (env.platform === 'win32') {
    if (env.localAppData) {
      // Classic npm global shim dir (Roaming) plus manager defaults.
      if (env.appData) add(join(env.appData, 'npm'))
      add(join(env.localAppData, 'pnpm'))
      add(join(env.localAppData, 'Volta', 'bin'))
      add(join(env.localAppData, 'Yarn', 'bin'))
      add(join(env.localAppData, 'fnm', 'aliases', 'default'))
      if (env.appData) add(join(env.appData, 'nvm'))
    }
    add(join(env.homeDir, '.bun', 'bin'))
  } else {
    add(join(env.homeDir, '.volta', 'bin'))
    add(join(env.homeDir, '.bun', 'bin'))
    add(process.env['PNPM_HOME'] ?? join(env.homeDir, '.local', 'share', 'pnpm'))
    const fnmAlias =
      process.env['FNM_DIR'] !== undefined
        ? join(process.env['FNM_DIR'], 'aliases', 'default', 'bin')
        : join(env.homeDir, '.fnm', 'aliases', 'default', 'bin')
    add(fnmAlias)
    // nvm only extends PATH from rc files, so the snapshot usually covers it;
    // probe the newest installed version as a fallback anyway.
    const nvmVersions = join(env.homeDir, '.nvm', 'versions', 'node')
    try {
      const versions = readdirSync(nvmVersions)
        .filter((v) => /^v?\d+(\.\d+){0,2}$/.test(v))
        .sort(compareVersionDesc)
      if (versions[0] !== undefined) add(join(nvmVersions, versions[0], 'bin'))
    } catch {
      // No nvm installation — expected on most machines.
    }
  }
  return dirs.filter((d) => existsSync(d))
}

function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const PATH_BEGIN = '__ARI_PATH_BEGIN__'
const PATH_END = '__ARI_PATH_END__'

let cachedLoginShellPath: Promise<string | null> | null = null

/**
 * Snapshot of the user's login-shell PATH (comet #121-class fix for "works in
 * my terminal"): spawns `$SHELL -lic` and reads PATH between sentinels, so
 * rc-file PATH extensions (nvm, fnm activate, custom bins) reach detection
 * even when Ari was launched from the dock/launcher with a minimal env.
 *
 * Hard-bounded: hostile rc files cannot wedge boot. Cached once per process
 * including failures; `ARI_NO_LOGIN_SHELL=1` opts out. Windows returns null —
 * GUI processes already receive the registry user PATH.
 */
export function loginShellPath(timeoutMs = 5000): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  if (process.env['ARI_NO_LOGIN_SHELL'] === '1') return Promise.resolve(null)
  cachedLoginShellPath ??= snapshotLoginShellPath(timeoutMs).catch((error: unknown) => {
    log.debug('login-shell snapshot failed', { error: String(error) })
    return null
  })
  return cachedLoginShellPath
}

async function snapshotLoginShellPath(timeoutMs: number): Promise<string | null> {
  const shell = process.env['SHELL']
  if (!shell || shell.length === 0) return null
  const script = `echo ${PATH_BEGIN}; printf '%s' "$PATH"; echo; echo ${PATH_END}`
  // Login+interactive first so profile/rc PATH edits run; plain login shell
  // as fallback for shells that reject -i without a tty.
  for (const args of [['-lic', script], ['-lc', script]]) {
    const result = await readPathFromShell(shell, args, timeoutMs)
    if (result !== null) return result
  }
  return null
}

function readPathFromShell(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    const done = (value: string | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      done(null)
      return
    }
    child.on('error', () => done(null))
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('close', () => {
      const start = stdout.indexOf(PATH_BEGIN)
      const end = stdout.indexOf(PATH_END)
      if (start < 0 || end < 0 || end <= start) {
        done(null)
        return
      }
      const raw = stdout.slice(start + PATH_BEGIN.length, end).trim()
      done(raw.length > 0 && !raw.includes('\n') ? raw : null)
    })
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill()
        done(null)
      }
    }, timeoutMs)
    timer.unref?.()
  })
}

/**
 * Child-process env with the detection PATH overlaid. GUI-launched Electron
 * often lacks npm/pnpm global bins; install/upgrade must use the same PATH
 * detection already searched (T3 Windows update fix).
 */
export function processEnvWithPath(
  pathEnv: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, PATH: pathEnv }
}

/**
 * Detection environment enriched for GUI launches: process PATH first (explicit
 * overrides win), then login-shell snapshot entries, then node version-manager
 * dirs. Deduped, order-stable.
 */
export async function resolveDetectionEnvironment(
  base: DetectEnvironment = realDetectEnvironment(),
): Promise<DetectEnvironment> {
  const [snapshot] = await Promise.all([loginShellPath()])
  const entries: string[] = []
  const pushAll = (value: string | null | undefined): void => {
    if (!value) return
    for (const dir of value.split(delimiter)) {
      if (dir.length > 0 && !entries.includes(dir)) entries.push(dir)
    }
  }
  pushAll(base.pathEnv)
  pushAll(snapshot)
  for (const dir of versionManagerDirs(base)) {
    if (!entries.includes(dir)) entries.push(dir)
  }
  return { ...base, pathEnv: entries.join(delimiter) }
}

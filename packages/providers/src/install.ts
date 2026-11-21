import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { createLogger } from '@ari/shared/logger'
import { teardownChild } from './teardown'
import { buildShellSpawnArgs, needsWindowsShell } from './spawn-cli'

const log = createLogger('providers:install')

/** A single line of streamed output. */
export interface InstallProgress {
  /** Either whole stdout/stderr is captured in order. */
  stream: 'stdout' | 'stderr'
  text: string
}

/** Tagged union: terminal events always carry `durationMs`. */
export type InstallEvent =
  | { type: 'started'; pid: number | undefined }
  | { type: 'progress'; line: InstallProgress }
  | {
      type: 'exit'
      code: number | null
      signal: NodeJS.Signals | null
      durationMs: number
      truncated: boolean
      /** Set when the timer fired and the ladder reaped the process. */
      timedOut: boolean
    }
  | { type: 'failed'; reason: string; durationMs: number }

export interface InstallHandle {
  /** Resolves when the process exits (any reason) or fails to spawn. */
  done: Promise<void>
  /** Tears down the running process using the shared ladder. */
  cancel: () => Promise<void>
}

/** Bounded cap on kept output; the oldest lines drop when exceeded. */
const OUTPUT_TAIL_BYTES = 10 * 1024
/** Hard ceiling on an install or upgrade attempt. */
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** Resolve the executable before dispatch so .cmd/.ps1 shims use the right Windows shell. */
export function resolveInstallProgram(program: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32' || /[\\/]/.test(program)) return program
  const pathEnv =
    env['PATH'] ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  for (const directory of pathEnv.split(';')) {
    for (const extension of /\.[a-z]+$/i.test(program)
      ? ['']
      : ['.exe', '.com', '.cmd', '.bat', '.ps1']) {
      const candidate = win32.join(directory.replace(/^"|"$/g, ''), `${program}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return program
}

/** True when `program` resolves on `pathEnv`, the way a spawn of the bare name would. */
export function programOnPath(
  program: string,
  pathEnv: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32'
  const paths = windows ? win32 : posix
  const extensions = windows ? ['.exe', '.com', '.cmd', '.bat', '.ps1'] : ['']
  return pathEnv
    .split(windows ? ';' : ':')
    .filter((directory) => directory.length > 0)
    .some((directory) =>
      extensions.some((extension) =>
        existsSync(paths.join(directory.replace(/^"|"$/g, ''), `${program}${extension}`)),
      ),
    )
}

export interface InstallRunnerOptions {
  /** Per-stream tail cap in bytes; older lines are dropped when exceeded. */
  outputTailBytes?: number
  /** Hard timeout for the operation. */
  timeoutMs?: number
  /** Working directory; defaults to the app userData. */
  cwd?: string
  /** Environment merged onto process.env. */
  env?: NodeJS.ProcessEnv
}

/**
 * Runs a package-manager install/upgrade as argv (never a shell) and surfaces
 * every chunk of output via a typed callback. Guarantees:
 *
 * - Tail-capped stdout/stderr — keeps the last ~10KB so the UI shows progress
 *   without growing without bound.
 * - Hard timeout; the shared teardown ladder reaps a hung process.
 * - A final terminal event always fires — `failed` for spawn-time or stdin
 *   errors, `exit` for any process termination (incl. timeout-forced kills).
 *
 * The caller MUST re-detect after the run completes; this runner does no
 * probing of its own.
 */
export function runInstall(
  argv: readonly string[],
  onEvent: (event: InstallEvent) => void,
  options: InstallRunnerOptions = {},
): InstallHandle {
  const { outputTailBytes = OUTPUT_TAIL_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env } = options

  if (argv.length === 0) {
    const event: InstallEvent = { type: 'failed', reason: 'empty argv', durationMs: 0 }
    onEvent(event)
    return { done: Promise.resolve(), cancel: () => Promise.resolve() }
  }

  const childEnv = sanitizeNpmEnv({ ...process.env, ...env })
  const program = resolveInstallProgram(argv[0] ?? '', childEnv)
  const args = argv.slice(1)
  const startedAt = Date.now()
  // Reuse spawnCli's shell dispatch so .cmd shims (npm/pnpm) get the
  // cross-spawn escaping and .ps1 scripts go through powershell.exe —
  // wrapping each arg in extra quotes produced `Unknown command: ""install""`
  // on Windows.
  const wrapped =
    process.platform === 'win32' && needsWindowsShell(program)
      ? buildShellSpawnArgs(program, args)
      : { file: program, args, windowsVerbatimArguments: false as const }
  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn(wrapped.file, wrapped.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(wrapped.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      env: childEnv,
    })
  } catch (error) {
    onEvent({ type: 'failed', reason: stringify(error), durationMs: Date.now() - startedAt })
    return { done: Promise.resolve(), cancel: () => Promise.resolve() }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  onEvent({ type: 'started', pid: child.pid })

  const stdout = ringTail(outputTailBytes)
  const stderr = ringTail(outputTailBytes)
  child.stdout.on('data', (chunk: string) => stdout.push(chunk, onEvent, 'stdout'))
  child.stderr.on('data', (chunk: string) => stderr.push(chunk, onEvent, 'stderr'))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    log.warn('install timeout exceeded; tearing down', { program, args, timeoutMs })
    void teardownChild(child, { termGraceMs: 1000 }).catch((error) =>
      log.warn('teardown failed', error),
    )
  }, timeoutMs)

  const done = new Promise<void>((resolveDone) => {
    let terminal = false
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (terminal) return
      terminal = true
      stdout.flush(onEvent, 'stdout')
      stderr.flush(onEvent, 'stderr')
      onEvent({
        type: 'exit',
        code,
        signal,
        durationMs: Date.now() - startedAt,
        truncated: stdout.overflowed() || stderr.overflowed(),
        timedOut,
      })
      resolveDone()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      if (terminal) return
      terminal = true
      onEvent({ type: 'failed', reason: stringify(error), durationMs: Date.now() - startedAt })
      resolveDone()
    })
  })

  return {
    done,
    cancel: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      await teardownChild(child, { termGraceMs: 500 })
    },
  }
}

function stringify(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

/** Drop parent-process npm_config_* so a pnpm/Electron host does not leak unknown npm configs into the install. */
function sanitizeNpmEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (/^npm_config_/i.test(key)) continue
    next[key] = value
  }
  return next
}

/**
 * A bounded ring of the most recent N bytes, with overflow tracking.
 *
 * Exported so its contract can be pinned without a child process: whether the
 * stream overflowed is a property of the bytes it produced, never of the reads
 * that happened to carry them.
 */
export function ringTail(maxBytes: number) {
  let buffer = ''
  let totalBytes = 0
  let overflowed = false
  return {
    overflowed: (): boolean => overflowed,
    flush(emit: (event: InstallEvent) => void, stream: 'stdout' | 'stderr'): void {
      if (buffer.trim())
        emit({ type: 'progress', line: { stream, text: buffer.replace(/\r$/, '') } })
      buffer = ''
    },
    push(chunk: string, emit: (event: InstallEvent) => void, stream: 'stdout' | 'stderr'): void {
      buffer += chunk
      // Count the whole stream, not the current read. A pipe coalesces writes
      // per platform — one large read on Linux, one read per line on Windows —
      // so comparing the buffer alone made this flag, and the "output
      // truncated" the UI shows with it, depend on the chunk size.
      totalBytes += chunk.length
      if (totalBytes > maxBytes) overflowed = true
      if (buffer.length > maxBytes) buffer = buffer.slice(buffer.length - maxBytes)
      // Emit line-by-line so the UI gets progress, not raw chunks.
      let index = buffer.indexOf('\n')
      let cursor = 0
      while (index !== -1) {
        const text = buffer.slice(cursor, index).replace(/\r$/, '')
        cursor = index + 1
        if (text.length > 0) emit({ type: 'progress', line: { stream, text } })
        index = buffer.indexOf('\n', cursor)
      }
      buffer = buffer.slice(cursor)
    },
  }
}

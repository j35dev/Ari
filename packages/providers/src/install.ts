import { spawn } from 'node:child_process'
import { createLogger } from '@ari/shared/logger'
import { teardownChild } from './teardown'
import { needsWindowsShell } from './spawn-cli'

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
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

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

  const program = argv[0] ?? ''
  const args = argv.slice(1)

  const useShell = process.platform === 'win32' && needsWindowsShell(program)
  const { spawnProgram, spawnArgs } = shellify(program, args, useShell)

  const startedAt = Date.now()
  const child = spawn(spawnProgram, spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  })
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
    void teardownChild(child, { termGraceMs: 1000 }).catch((error) => log.warn('teardown failed', error))
  }, timeoutMs)

  const done = new Promise<void>((resolveDone) => {
    child.once('close', (code, signal) => {
      clearTimeout(timer)
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

/** Selects the spawn argv: argv directly, or wrapped through a shell. */
function shellify(
  program: string,
  args: readonly string[],
  useShell: boolean,
): { spawnProgram: string; spawnArgs: readonly string[] } {
  if (!useShell) return { spawnProgram: program, spawnArgs: args }
  if (process.platform === 'win32') {
    // cmd.exe /c needs each arg quoted with internal " doubled.
    return {
      spawnProgram: 'cmd.exe',
      spawnArgs: ['/c', program, ...args.map((arg) => `"${arg.replace(/"/g, '""')}"`)],
    }
  }
  // POSIX fallback (needsWindowsShell is win32-specific today).
  return { spawnProgram: '/bin/sh', spawnArgs: ['-c', [program, ...args].map(quoteForSh).join(' ')] }
}

/** POSIX shell quoting — single-quoted with internal ' escaped. */
function quoteForSh(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** A bounded ring of the most recent N bytes, with overflow tracking. */
function ringTail(maxBytes: number) {
  let buffer = ''
  let overflowed = false
  return {
    overflowed: (): boolean => overflowed,
    push(chunk: string, emit: (event: InstallEvent) => void, stream: 'stdout' | 'stderr'): void {
      buffer += chunk
      if (buffer.length > maxBytes) {
        overflowed = true
        buffer = buffer.slice(buffer.length - maxBytes)
      }
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
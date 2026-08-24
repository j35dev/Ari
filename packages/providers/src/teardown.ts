import { spawn } from 'node:child_process'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('providers:teardown')

/**
 * The slice of a spawned CLI process the ladder needs. Deliberately structural
 * so both real `ChildProcess`es and the drivers' narrower process-like types
 * (claude's `ControlProcessLike`, codex's `LegacyChildProcess`) qualify.
 */
export interface TeardownTarget {
  pid?: number | undefined
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
  stdin?: { end(): void; writableEnded: boolean } | null
  kill(signal?: NodeJS.Signals): boolean
  /**
   * Optional: the drivers' narrow legacy process types only expose `on`.
   * Without it the ladder falls back to polling for exit.
   */
  once?(event: string, listener: () => void): unknown
}

/**
 * Shared teardown ladder for provider CLI processes. Rungs, in order:
 *
 * 1. Close stdin (EOF) and give the CLI a short grace to exit on its own.
 * 2. SIGTERM.
 * 3. Kill the whole tree — on win32 SIGTERM does not reach grandchildren, so
 *    `taskkill /T /F` is used; elsewhere SIGKILL.
 *
 * Every rung is raced against the child's `close` event, so a cooperative
 * process never sees a later rung. Safe to call more than once per child and
 * safe on an already-exited child. Resolves once the process is confirmed
 * gone (or its pid is unrecoverable).
 */
export async function teardownChild(
  child: TeardownTarget,
  options: TeardownOptions = {},
): Promise<void> {
  const { eofGraceMs = 300, termGraceMs = 2000, killTree = defaultKillTree } = options
  if (isGone(child)) return

  const exited = onceClose(child)

  // Rung 1: EOF.
  if (child.stdin && !child.stdin.writableEnded) child.stdin.end()
  if (await raceExit(exited, eofGraceMs)) return

  // Rung 2: SIGTERM.
  log.debug('teardown escalating to SIGTERM', { pid: child.pid })
  try {
    child.kill('SIGTERM')
  } catch {
    // Already dead between the check and the call.
  }
  if (await raceExit(exited, termGraceMs)) return

  // Rung 3: tree kill.
  const pid = child.pid
  if (pid === undefined) return
  log.debug('teardown killing process tree', { pid })
  try {
    await killTree(pid)
  } catch (error) {
    log.warn('tree kill failed', error)
  }
  await raceExit(exited, termGraceMs)
}

export interface TeardownOptions {
  /** How long stdin-EOF gets to end the process on its own. */
  eofGraceMs?: number
  /** How long SIGTERM gets before the tree is killed. */
  termGraceMs?: number
  /** Overridable final rung (tests). */
  killTree?: (pid: number) => Promise<void>
}

const tornDown = new WeakSet<object>()

function isGone(child: TeardownTarget): boolean {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

function onceClose(child: TeardownTarget): Promise<void> {
  if (tornDown.has(child)) return Promise.resolve()
  tornDown.add(child)
  if (!child.once) return pollGone(child)
  const once: (event: string, listener: () => void) => unknown = child.once.bind(child)
  return new Promise((resolvePromise) => {
    if (isGone(child)) {
      resolvePromise()
      return
    }
    const done = (): void => resolvePromise()
    once('close', done)
    once('error', done)
  })
}

/** Fallback for legacy process types without an event emitter surface. */
async function pollGone(child: TeardownTarget, intervalMs = 25): Promise<void> {
  while (!isGone(child)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
}

/** Resolves true when `exited` wins; false when `ms` elapses first. */
async function raceExit(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), ms)
  })
  try {
    return await Promise.race([exited.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Final rung: take down the whole tree, not just the direct child. */
function defaultKillTree(pid: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (process.platform === 'win32') {
      // SIGTERM/SIGKILL do not propagate to grandchildren on Windows.
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      taskkill.once('exit', (code) =>
        code === 0 ? resolvePromise() : rejectPromise(new Error(`taskkill exit ${code}`)),
      )
      taskkill.once('error', rejectPromise)
      return
    }
    try {
      process.kill(pid, 'SIGKILL')
      resolvePromise()
    } catch (error) {
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

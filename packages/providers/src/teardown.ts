import { execFile, spawn } from 'node:child_process'
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
  const {
    eofGraceMs = 300,
    termGraceMs = 2000,
    killTree = defaultKillTree,
    killOrphans = defaultKillOrphans,
    platform = process.platform,
  } = options
  if (isGone(child)) {
    // A Windows shell wrapper can be gone while the CLI it started still runs
    // and holds the pipes open. A tree kill through the dead pid no longer
    // reaches it, so find what the wrapper started while it lived.
    const wrapper = shellWrappers.get(child)
    const pid = child.pid
    if (platform !== 'win32' || !wrapper || wrapper.closed || pid === undefined) return
    log.debug('teardown killing processes orphaned by a shell wrapper', { pid })
    try {
      await killOrphans(pid, wrapper.spawnedAt, wrapper.exitedAt ?? Date.now())
    } catch (error) {
      log.warn('orphan kill failed', error)
    }
    await raceExit(onceClose(child), termGraceMs)
    return
  }

  const exited = onceClose(child)

  // Rung 1: EOF. Without a grace the next rung starts synchronously.
  if (child.stdin && !child.stdin.writableEnded) child.stdin.end()
  if (eofGraceMs > 0 && (await raceExit(exited, eofGraceMs))) return

  // Rung 2: SIGTERM. On Windows that is TerminateProcess on the direct child
  // alone: a cmd.exe shim dies, and the CLI it started keeps running beyond
  // the reach of a later tree kill. Windows goes straight to the tree.
  if (platform !== 'win32' || child.pid === undefined) {
    log.debug('teardown escalating to SIGTERM', { pid: child.pid })
    try {
      child.kill('SIGTERM')
    } catch {
      // Already dead between the check and the call.
    }
    if (await raceExit(exited, termGraceMs)) return
  }

  // Rung 3: tree kill.
  const pid = child.pid
  if (pid === undefined) return
  log.debug('teardown killing process tree', { pid })
  try {
    await killTree(pid)
  } catch (error) {
    log.warn('tree kill failed', error)
    try {
      child.kill('SIGTERM')
    } catch {
      // Already dead.
    }
  }
  await raceExit(exited, termGraceMs)
}

/**
 * Stop for a one-shot CLI: its prompt already went, so skip the EOF grace and
 * take down the whole process tree. A bare kill() on Windows ends only the
 * cmd.exe shim and leaves the real agent running.
 */
export function interruptChild(child: TeardownTarget): void {
  void teardownChild(child, { eofGraceMs: 0 })
}

interface ShellWrapper {
  spawnedAt: number
  exitedAt?: number
  closed: boolean
}

const shellWrappers = new WeakMap<object, ShellWrapper>()

/**
 * Remembers a Windows shell wrapper's (cmd.exe, powershell.exe) lifetime, so
 * teardown can still reach the CLI it started once the wrapper is gone.
 */
export function trackShellWrapper(child: {
  once(event: string, listener: () => void): unknown
}): void {
  const wrapper: ShellWrapper = { spawnedAt: Date.now(), closed: false }
  shellWrappers.set(child, wrapper)
  child.once('exit', () => {
    wrapper.exitedAt = Date.now()
  })
  child.once('close', () => {
    wrapper.closed = true
  })
}

export interface TeardownOptions {
  /** How long stdin-EOF gets to end the process on its own. */
  eofGraceMs?: number
  /** How long SIGTERM gets before the tree is killed. */
  termGraceMs?: number
  /** Overridable final rung (tests). */
  killTree?: (pid: number) => Promise<void>
  /** Overridable sweep of a gone wrapper's surviving children (tests). */
  killOrphans?: (parentPid: number, spawnedAt: number, exitedAt: number) => Promise<void>
  /** Overridable platform (tests). */
  platform?: NodeJS.Platform
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

/**
 * Kills the trees of processes a gone Windows parent started. Windows keeps a
 * child's parent pid after the parent exits, but that pid can be reused, so
 * only children created during the parent's own lifetime count.
 */
async function defaultKillOrphans(
  parentPid: number,
  spawnedAt: number,
  exitedAt: number,
): Promise<void> {
  const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15_000 },
      (error: Error | null, out: string) => (error ? rejectPromise(error) : resolvePromise(out)),
    )
  })
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, createdAt] = line.trim().split(' ').map(Number)
    if (!pid || !createdAt) continue
    // CIM creation times are whole milliseconds; allow for clock rounding.
    if (createdAt < spawnedAt - 1000 || createdAt > exitedAt) continue
    await defaultKillTree(pid).catch((error: unknown) => log.warn('orphan tree kill failed', error))
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

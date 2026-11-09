import { exec } from 'node:child_process'
import { resolve } from 'node:path'
import { isWithinRoot } from '@ari/shared/paths'

const MAX_SCROLLBACK = 1024 * 1024
/**
 * Trim floor: overflow slices back to this size, so steady output overflows
 * the 128KB difference before the next slice instead of rounding a 1MB
 * string per pty chunk. The ring always stays within MAX_SCROLLBACK,
 * losslessly holding every byte written since the last trim.
 */
export const TRIM_FLOOR = MAX_SCROLLBACK - 128 * 1024

/** Minimal pty surface used by the service; satisfied by node-pty's IPty. */
export interface PtyLike {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (exitCode: number, signal?: number) => void): void
}

export interface PtySpawnOptions {
  name: string
  cwd: string
  env: Record<string, string>
  windowsHide: boolean
}

export type PtyFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyLike

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string) => void
}

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] }
  if (process.platform === 'darwin') return { file: '/bin/zsh', args: ['-l'] }
  return { file: '/bin/bash', args: [] }
}

/**
 * Names why no pty is available. A permanent load failure (the prebuilt
 * platform package missing from a package, say) must not read as a cold start:
 * the pane shows this verbatim, and "still loading" would never resolve.
 */
export function ptyUnavailableReason(loadError: string | null): string {
  return loadError !== null
    ? `terminal backend unavailable — ${loadError}`
    : 'terminal backend still loading'
}

function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      try {
        exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => resolve())
      } catch {
        // Still release the native handle if the cleanup process cannot start.
        resolve()
      }
    })
  } else {
    try {
      process.kill(-pid)
    } catch {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
  }
  return Promise.resolve()
}

interface Session {
  pty: PtyLike
  scrollback: string
  exited: boolean
  cwd: string
}

/**
 * Owns live pty sessions for the terminal pane. Each session keeps a 1MB
 * scrollback ring so late subscribers can replay what they missed. The pty
 * factory is injected: production passes a node-pty adapter, tests pass a
 * fake (the native module is built against Electron's ABI).
 */
export class TerminalService {
  readonly #sessions = new Map<string, Session>()
  readonly #events: TerminalEvents
  readonly #spawnPty: PtyFactory
  readonly #pendingKills = new Set<Promise<void>>()
  #closed = false

  constructor(events: TerminalEvents, spawnPty: PtyFactory) {
    this.#events = events
    this.#spawnPty = spawnPty
  }

  /** Interactive shell inside a jailed project directory. */
  create(id: string, cwd: string): void {
    const shell = defaultShell()
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[name] = value
    }
    this.spawn(id, shell.file, shell.args, cwd, env)
  }

  /**
   * A specific program, not a shell. Sign-in uses this so keystrokes are
   * stdin for that program and cannot start another command.
   */
  spawn(id: string, file: string, args: string[], cwd: string, env: Record<string, string>): void {
    if (this.#closed) throw new Error('Ari is shutting down')
    if (this.#sessions.has(id)) return
    const pty = this.#spawnPty(file, args, {
      name: 'xterm-256color',
      cwd,
      env,
      windowsHide: true,
    })
    const session: Session = { pty, scrollback: '', exited: false, cwd: resolve(cwd) }
    this.#sessions.set(id, session)
    pty.onData((data) => {
      session.scrollback += data
      if (session.scrollback.length > MAX_SCROLLBACK) {
        session.scrollback = session.scrollback.slice(-TRIM_FLOOR)
      }
      this.#events.onData(id, data)
    })
    pty.onExit(() => {
      session.exited = true
      this.#events.onExit(id)
    })
  }

  write(id: string, data: string): void {
    this.#sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.#sessions.get(id)?.pty.resize(cols, rows)
    } catch {
      // resizing a dead session is a no-op
    }
  }

  /** Waits for shells inside a workspace before that directory is removed. */
  async killInWorkspace(root: string): Promise<void> {
    const ids = [...this.#sessions]
      .filter(([, session]) => isWithinRoot(session.cwd, root))
      .map(([id]) => id)
    await Promise.all(ids.map((id) => this.kill(id)))
  }

  kill(id: string): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session) return Promise.resolve()
    this.#sessions.delete(id)
    const cleanup = (async () => {
      try {
        // Keep the shell alive until taskkill has enumerated its descendants.
        // Closing ConPTY first can orphan detached children before /T runs.
        // An exited shell's PID may already belong to another process.
        if (!session.exited && session.pty.pid > 0) await killTree(session.pty.pid)
      } finally {
        // Tree termination does not release the native ConPTY/file descriptor.
        try {
          session.pty.kill()
        } catch {
          // already gone
        }
      }
    })()
    this.#pendingKills.add(cleanup)
    void cleanup.finally(() => this.#pendingKills.delete(cleanup))
    return cleanup
  }

  /** Release every native handle and its child process tree on app shutdown. */
  async close(): Promise<void> {
    this.#closed = true
    for (const id of this.#sessions.keys()) void this.kill(id)
    await Promise.all(this.#pendingKills)
  }

  replay(id: string): string {
    return this.#sessions.get(id)?.scrollback ?? ''
  }

  has(id: string): boolean {
    return this.#sessions.has(id)
  }
}

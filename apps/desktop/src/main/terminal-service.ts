import { exec } from 'node:child_process'
import { resolve, sep } from 'node:path'

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

async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => done())
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
}

interface Session {
  pty: PtyLike
  scrollback: string
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
    if (this.#sessions.has(id)) return
    const pty = this.#spawnPty(file, args, {
      name: 'xterm-256color',
      cwd,
      env,
      windowsHide: true,
    })
    const session: Session = { pty, scrollback: '', cwd: resolve(cwd) }
    this.#sessions.set(id, session)
    pty.onData((data) => {
      session.scrollback += data
      if (session.scrollback.length > MAX_SCROLLBACK) {
        session.scrollback = session.scrollback.slice(-TRIM_FLOOR)
      }
      this.#events.onData(id, data)
    })
    pty.onExit(() => this.#events.onExit(id))
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

  kill(id: string): void {
    void this.#kill(id)
  }

  /** Waits for shells opened inside a workspace before that directory is removed. */
  async killInWorkspace(root: string): Promise<void> {
    const key = (path: string): string =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    const target = key(root)
    const ids = [...this.#sessions]
      .filter(([, session]) => {
        const cwd = key(session.cwd)
        return cwd === target || cwd.startsWith(target + sep)
      })
      .map(([id]) => id)
    await Promise.all(ids.map((id) => this.#kill(id, true)))
  }

  async #kill(id: string, treeFirst = false): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session) return
    this.#sessions.delete(id)
    // Workspace removal must kill descendants while their parent PID still
    // exists; a shell exiting first can leave children holding the directory.
    if (treeFirst) await killTree(session.pty.pid)
    // Tree shutdown alone leaks the ConPTY/file descriptor; release the
    // native handle even when its process has already exited.
    try {
      session.pty.kill()
    } catch {
      // already gone
    }
    if (!treeFirst) await killTree(session.pty.pid)
  }

  replay(id: string): string {
    return this.#sessions.get(id)?.scrollback ?? ''
  }

  has(id: string): boolean {
    return this.#sessions.has(id)
  }
}

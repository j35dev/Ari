import { exec } from 'node:child_process'

const MAX_SCROLLBACK = 1024 * 1024

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

export type PtyFactory = (
  file: string,
  args: string[],
  options: PtySpawnOptions,
) => PtyLike

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string) => void
}

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] }
  if (process.platform === 'darwin') return { file: '/bin/zsh', args: ['-l'] }
  return { file: '/bin/bash', args: [] }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    exec(`taskkill /PID ${pid} /T /F`, () => undefined)
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

  create(id: string, cwd: string): void {
    if (this.#sessions.has(id)) return
    const shell = defaultShell()
    const pty = this.#spawnPty(shell.file, shell.args, {
      name: 'xterm-256color',
      cwd,
      env: process.env as Record<string, string>,
      windowsHide: true,
    })
    const session: Session = { pty, scrollback: '' }
    this.#sessions.set(id, session)
    pty.onData((data) => {
      session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK)
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
    const session = this.#sessions.get(id)
    if (!session) return
    this.#sessions.delete(id)
    killTree(session.pty.pid)
  }

  replay(id: string): string {
    return this.#sessions.get(id)?.scrollback ?? ''
  }

  has(id: string): boolean {
    return this.#sessions.has(id)
  }
}

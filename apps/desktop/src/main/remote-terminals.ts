import { randomUUID } from 'node:crypto'
import type { RemoteCommand, RemoteTerminal } from '@ari/contracts/remote'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import { createLogger } from '@ari/shared/logger'
import { TerminalService, type PtyFactory } from './terminal-service'

type TerminalCommand = Extract<RemoteCommand, { op: `terminal.${string}` }>
interface Entry {
  deviceId: string
  sessionId: string
  projectId: string
  data: string
  seq: number
  exited: boolean
  managedLeaseExpiresAt?: number
}
const log = createLogger('desktop:remote-terminals')

/** Device-owned shells with bounded replay; cwd is convenience, not an OS sandbox. */
export class RemoteTerminals {
  readonly #entries = new Map<string, Entry>()
  readonly #terminals: TerminalService
  readonly #watchdog: ReturnType<typeof setInterval>
  readonly #now: () => number

  constructor(factory: PtyFactory, allowed: (deviceId: string, projectId: string) => boolean, now: () => number = Date.now) {
    this.#now = now
    this.#terminals = new TerminalService(
      {
        onData: (id, data) => {
          const entry = this.#entries.get(id)
          if (entry === undefined) return
          entry.seq += data.length
          entry.data = (entry.data + data).slice(-131_072)
        },
        onExit: (id) => {
          const entry = this.#entries.get(id)
          if (entry !== undefined) entry.exited = true
        },
      },
      (file, args, options) => {
        const env = { ...options.env }
        for (const key of Object.keys(env))
          if (
            key.startsWith('ARI_CONTROL_') ||
            key === 'ARI_CLI' ||
            key === 'ARI_BROWSER_MCP_TOKEN'
          )
            delete env[key]
        return factory(file, args, { ...options, env })
      },
    )
    this.#watchdog = setInterval(() => {
      for (const [id, entry] of this.#entries)
        if (!allowed(entry.deviceId, entry.projectId) || this.#expired(entry)) this.#kill(id)
    }, 1000)
    this.#watchdog.unref()
  }

  execute(
    caller: RemoteCaller,
    command: TerminalCommand,
    session: { projectId: string; workspace: string },
  ): { ok: true; result: unknown } | { ok: false; code: string; message: string } {
    if (caller.allowTerminal !== true)
      return {
        ok: false,
        code: 'access_revoked',
        message:
          'Terminal access requires explicit approval on this computer. Pair again with terminal access enabled.',
      }
    if (caller.managedLeaseExpiresAt !== undefined && caller.managedLeaseExpiresAt <= this.#now())
      return { ok: false, code: 'access_revoked', message: 'The Ari Connect lease expired.' }
    try {
      if (command.op === 'terminal.create') {
        if (
          this.#entries.size >= 8 ||
          [...this.#entries.values()].filter((entry) => entry.deviceId === caller.deviceId)
            .length >= 2
        )
          return {
            ok: false,
            code: 'rate_limited',
            message: 'Close an existing terminal before opening another.',
          }
        const terminalId = `term_${randomUUID()}`
        this.#entries.set(terminalId, {
          deviceId: caller.deviceId,
          sessionId: command.sessionId,
          projectId: session.projectId,
          data: '',
          seq: 0,
          exited: false,
          ...(caller.managedLeaseExpiresAt === undefined ? {} : { managedLeaseExpiresAt: caller.managedLeaseExpiresAt }),
        })
        try {
          this.#terminals.create(terminalId, session.workspace)
          this.#terminals.resize(terminalId, command.cols, command.rows)
        } catch (error) {
          this.#entries.delete(terminalId)
          throw error
        }
        return { ok: true, result: { terminalId } }
      }
      const entry = this.#entries.get(command.terminalId)
      if (
        entry === undefined ||
        entry.deviceId !== caller.deviceId ||
        entry.sessionId !== command.sessionId ||
        !this.#authorizeEntry(caller, command.terminalId, entry)
      )
        return { ok: false, code: 'not_found', message: 'no such terminal' }
      if (command.op === 'terminal.kill') {
        this.#kill(command.terminalId)
        return { ok: true, result: { killed: true } }
      }
      if (entry.exited)
        return { ok: false, code: 'conflict', message: 'The shell exited. Open a new terminal.' }
      if (command.op === 'terminal.write') this.#terminals.write(command.terminalId, command.data)
      else this.#terminals.resize(command.terminalId, command.cols, command.rows)
      return { ok: true, result: { accepted: true } }
    } catch {
      log.warn('remote terminal operation failed')
      return {
        ok: false,
        code: 'conflict',
        message:
          'The terminal backend is unavailable or the shell stopped. Check the desktop and retry.',
      }
    }
  }

  read(
    caller: RemoteCaller,
    sessionId: string,
    terminalId: string,
    fromSeq: number,
  ): RemoteTerminal | null {
    const entry = this.#entries.get(terminalId)
    if (
      caller.allowTerminal !== true ||
      entry === undefined ||
      entry.deviceId !== caller.deviceId ||
      entry.sessionId !== sessionId ||
      !this.#authorizeEntry(caller, terminalId, entry)
    )
      return null
    const start = entry.seq - entry.data.length
    const reset = fromSeq < start || fromSeq > entry.seq
    const cursor = reset ? start : fromSeq
    const data = entry.data.slice(cursor - start, cursor - start + 32_768)
    return {
      terminalId,
      data,
      seq: cursor + data.length,
      reset,
      exited: entry.exited,
      hasMore: cursor + data.length < entry.seq,
      error: null,
    }
  }

  close(): Promise<void> {
    clearInterval(this.#watchdog)
    this.#entries.clear()
    return this.#terminals.close()
  }
  closeManaged(): void {
    for (const [id, entry] of this.#entries)
      if (entry.managedLeaseExpiresAt !== undefined) this.#kill(id)
  }

  #expired(entry: Entry): boolean {
    return entry.managedLeaseExpiresAt !== undefined && entry.managedLeaseExpiresAt <= this.#now()
  }

  #authorizeEntry(caller: RemoteCaller, id: string, entry: Entry): boolean {
    if (this.#expired(entry)) {
      this.#kill(id)
      return false
    }
    if ((entry.managedLeaseExpiresAt === undefined) !== (caller.managedLeaseExpiresAt === undefined)) return false
    if (caller.managedLeaseExpiresAt !== undefined) {
      if (caller.managedLeaseExpiresAt <= this.#now() || !caller.projectIds.includes(entry.projectId)) return false
      entry.managedLeaseExpiresAt = Math.max(entry.managedLeaseExpiresAt ?? 0, caller.managedLeaseExpiresAt)
    }
    return true
  }
  #kill(id: string): void {
    void this.#terminals.kill(id)
    this.#entries.delete(id)
  }
}

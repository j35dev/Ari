import { randomUUID } from 'node:crypto'
import type { RemoteCommand, RemoteTerminal } from '@ari/contracts/remote'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import { createLogger } from '@ari/shared/logger'
import { TerminalService, type PtyFactory } from './terminal-service'

type TerminalCommand = Extract<RemoteCommand, { op: `terminal.${string}` }>
interface Entry {
  deviceId: string
  sessionId: string
  data: string
  seq: number
  exited: boolean
}
const log = createLogger('desktop:remote-terminals')

/** Device-owned shells with bounded replay; cwd is convenience, not an OS sandbox. */
export class RemoteTerminals {
  readonly #entries = new Map<string, Entry>()
  readonly #terminals: TerminalService
  readonly #watchdog: ReturnType<typeof setInterval>

  constructor(factory: PtyFactory, allowed: (deviceId: string) => boolean) {
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
      for (const [id, entry] of this.#entries) if (!allowed(entry.deviceId)) this.#kill(id)
    }, 1000)
    this.#watchdog.unref()
  }

  execute(
    caller: RemoteCaller,
    command: TerminalCommand,
    workspace: string,
  ): { ok: true; result: unknown } | { ok: false; code: string; message: string } {
    if (caller.allowTerminal !== true)
      return {
        ok: false,
        code: 'access_revoked',
        message:
          'Terminal access requires explicit approval on this computer. Pair again with terminal access enabled.',
      }
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
          data: '',
          seq: 0,
          exited: false,
        })
        try {
          this.#terminals.create(terminalId, workspace)
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
        entry.sessionId !== command.sessionId
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
      entry.sessionId !== sessionId
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

  close(): void {
    clearInterval(this.#watchdog)
    for (const id of this.#entries.keys()) this.#kill(id)
  }
  #kill(id: string): void {
    this.#terminals.kill(id)
    this.#entries.delete(id)
  }
}

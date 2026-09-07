import { createServer, type Server, type Socket } from 'node:net'
import { chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  AGENT_CONTROL_VERSION,
  CONTROL_MAX_FRAME_BYTES,
  controlHelloSchema,
  controlRequestSchema,
  type ControlMethod,
  type ControlResult,
} from '@ari/contracts/agent-control'

export interface ControlServerOptions {
  endpoint: string
  invoke(
    caller: string,
    method: ControlMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<ControlResult>
}

/** Local-only authenticated control transport with per-runtime session credentials. */
export class AgentControlServer {
  readonly #tokens = new Map<string, string>()
  readonly #sessionTokens = new Map<string, string>()
  readonly #sockets = new Set<Socket>()
  readonly #server: Server
  constructor(readonly options: ControlServerOptions) {
    this.#server = createServer((socket) => this.#accept(socket))
  }

  /** Returns a stable credential for this session runtime, never its parent's credential. */
  tokenFor(sessionId: string): string {
    const existing = this.#sessionTokens.get(sessionId)
    if (existing) return existing
    const token = randomBytes(32).toString('hex')
    this.#tokens.set(token, sessionId)
    this.#sessionTokens.set(sessionId, token)
    return token
  }

  /** Revokes credentials when the owning session is destroyed. */
  revoke(sessionId: string): void {
    const token = this.#sessionTokens.get(sessionId)
    if (token) this.#tokens.delete(token)
    this.#sessionTokens.delete(sessionId)
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.options.endpoint, () => {
        this.#server.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(this.options.endpoint, 0o600)
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    this.#tokens.clear()
    this.#sessionTokens.clear()
    if (this.#server.listening)
      await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  #accept(socket: Socket): void {
    if (this.#sockets.size >= 128) {
      socket.destroy()
      return
    }
    this.#sockets.add(socket)
    const controller = new AbortController()
    let token: string | null = null
    let buffer = Buffer.alloc(0)
    let requests = 0
    let pending = 0
    const send = (frame: unknown): void => {
      if (socket.destroyed) return
      const encoded = JSON.stringify(frame) + '\n'
      if (
        Buffer.byteLength(encoded) > CONTROL_MAX_FRAME_BYTES ||
        socket.writableLength > CONTROL_MAX_FRAME_BYTES * 2
      ) {
        socket.destroy()
        return
      }
      if (!socket.write(encoded)) socket.pause()
    }
    const fail = (code: string): void => {
      send({ type: 'error', ok: false, error: { code, message: code.replaceAll('_', ' ') } })
      socket.end()
    }
    socket.on('drain', () => socket.resume())
    socket.setTimeout(15_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      controller.abort()
      this.#sockets.delete(socket)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.includes(10)) {
        const end = buffer.indexOf(10)
        if (end > CONTROL_MAX_FRAME_BYTES) {
          fail('output_too_large')
          return
        }
        const line = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 1)
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          fail('invalid_request')
          return
        }
        if (!token) {
          const hello = controlHelloSchema.safeParse(frame)
          if (!hello.success) {
            fail('unauthorized')
            return
          }
          if (hello.data.version !== AGENT_CONTROL_VERSION) {
            fail('protocol_version_mismatch')
            return
          }
          if (!this.#tokens.has(hello.data.token)) {
            fail('unauthorized')
            return
          }
          token = hello.data.token
          send({ type: 'ready', version: AGENT_CONTROL_VERSION })
          continue
        }
        const caller = this.#tokens.get(token)
        if (!caller) {
          fail('unauthorized')
          return
        }
        const request = controlRequestSchema.safeParse(frame)
        if (!request.success) {
          fail('invalid_request')
          return
        }
        const { id, method, params } = request.data
        if (++requests > 1000) {
          send({
            type: 'response',
            id,
            ok: false,
            error: { code: 'delegation_limit', message: 'Control operation limit reached.' },
          })
          continue
        }
        if (pending >= 8) {
          send({
            type: 'response',
            id,
            ok: false,
            error: {
              code: 'delegation_limit',
              message: 'Too many in-flight control requests.',
            },
          })
          continue
        }
        pending++
        socket.setTimeout(3_660_000)
        let answered = false
        const requestController = new AbortController()
        const signal = AbortSignal.any([controller.signal, requestController.signal])
        const timer = setTimeout(() => {
          if (answered) return
          answered = true
          requestController.abort()
          send({
            type: 'response',
            id,
            ok: false,
            error: { code: 'control_timeout', message: 'Control request timed out.' },
          })
        }, 3_660_000)
        void this.options
          .invoke(caller, method, params, signal)
          .then((result) => {
            if (answered) return
            answered = true
            send({ type: 'response', id, ...result })
          })
          .catch(() => {
            if (answered) return
            answered = true
            send({
              type: 'response',
              id,
              ok: false,
              error: { code: 'internal_error', message: 'Control request failed.' },
            })
          })
          .finally(() => {
            clearTimeout(timer)
            if (--pending === 0) socket.setTimeout(15_000)
          })
      }
      if (buffer.length > CONTROL_MAX_FRAME_BYTES) fail('output_too_large')
    })
  }
}

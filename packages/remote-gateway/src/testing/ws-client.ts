import { once } from 'node:events'
import { connect, type Socket } from 'node:net'

/**
 * A raw WebSocket client for tests.
 *
 * The platform client cannot set `Origin`, and it fails the connection if the
 * server answers with a subprotocol it did not offer — both of which are
 * exactly the behaviours worth testing. It also will not emit a fragmented
 * message on demand. Driving the wire by hand covers all three.
 */

/** One masked client→server frame, as RFC 6455 requires. */
export function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([1, 2, 3, 4])
  const header: number[] = [(fin ? 0x80 : 0) | opcode]
  if (payload.length < 126) {
    header.push(0x80 | payload.length)
  } else {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] as number) ^ (mask[i % 4] as number)
  return Buffer.concat([Buffer.from(header), mask, masked])
}

export interface HandshakeResult {
  statusLine: string
  headers: Record<string, string>
  socket: Socket
}

/** Performs the opening handshake, whatever the server answers. */
export async function handshake(
  port: number,
  path: string,
  options: { origin?: string | null; protocols?: string[] } = {},
): Promise<HandshakeResult> {
  const socket = connect({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
  ]
  if (options.origin !== null && options.origin !== undefined) {
    lines.push(`Origin: ${options.origin}`)
  }
  if (options.protocols !== undefined && options.protocols.length > 0) {
    lines.push(`Sec-WebSocket-Protocol: ${options.protocols.join(', ')}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)

  const [chunk] = (await once(socket, 'data')) as [Buffer]
  const text = chunk.toString()
  const [statusLine = '', ...headerLines] = text.split('\r\n')
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const index = line.indexOf(':')
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim()
  }
  return { statusLine, headers, socket }
}

/** A connected client that has already completed the handshake. */
export class RawWebSocket {
  #buffer: Buffer
  #waiters: ((text: string) => void)[] = []

  constructor(
    readonly socket: Socket,
    leftover: Buffer = Buffer.alloc(0),
  ) {
    this.#buffer = leftover
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
  }

  static async open(
    port: number,
    path: string,
    options: { origin?: string | null; protocols?: string[] } = {},
  ): Promise<RawWebSocket> {
    const result = await handshake(port, path, options)
    if (!result.statusLine.includes('101')) {
      throw new Error(`expected an upgrade, got: ${result.statusLine}`)
    }
    return new RawWebSocket(result.socket)
  }

  send(text: string): void {
    this.socket.write(clientFrame(0x1, Buffer.from(text, 'utf8')))
  }

  /** Resolves with the next complete text message the server sent. */
  nextMessage(): Promise<string> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve)
      this.#drain()
    })
  }

  close(): void {
    this.socket.destroy()
  }

  #drain(): void {
    while (this.#waiters.length > 0) {
      if (this.#buffer.length < 2) return
      let length = (this.#buffer[1] as number) & 0x7f
      let offset = 2
      // Server frames are unmasked, but their length uses whichever of the
      // three encodings fits — a frame past 125 bytes is the common case here,
      // and assuming the 7-bit form would silently stall on it.
      if (length === 126) {
        if (this.#buffer.length < 4) return
        length = this.#buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.#buffer.length < 10) return
        length = Number(this.#buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (this.#buffer.length < offset + length) return
      const payload = this.#buffer.subarray(offset, offset + length).toString('utf8')
      this.#buffer = this.#buffer.subarray(offset + length)
      const resolve = this.#waiters.shift()
      resolve?.(payload)
    }
  }
}

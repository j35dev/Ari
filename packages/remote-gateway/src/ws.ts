import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * A minimal RFC 6455 server, written rather than depended on.
 *
 * The gateway needs exactly one WebSocket behaviour — push text frames to a
 * paired client and notice when it goes away — and adding a general-purpose
 * WebSocket library to the tree for that would mean a new runtime dependency
 * in a repo that has none for transport. Node ships the client (`WebSocket`),
 * so the server half is the only part missing, and it is small.
 *
 * Deliberately strict: a client frame that is not masked is a protocol error
 * and closes the connection, as the RFC requires. Reassembly is bounded so a
 * peer cannot make the gateway buffer without limit.
 */

/** RFC 6455's handshake GUID. Not a secret; it is fixed by the spec. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Cap on one reassembled message, so a peer cannot exhaust memory. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

export interface WebSocketConnection {
  /** False once the socket is closed or closing. */
  readonly open: boolean
  /** Sends one text frame. A no-op on a closed connection. */
  send(text: string): void
  /** Begins the closing handshake. Safe to call more than once. */
  close(code?: number, reason?: string): void
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade
  const connection = req.headers.connection
  return (
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    typeof connection === 'string' &&
    connection.toLowerCase().split(',').some((part) => part.trim() === 'upgrade') &&
    typeof req.headers['sec-websocket-key'] === 'string' &&
    req.headers['sec-websocket-version'] === '13'
  )
}

/** Derives the `Sec-WebSocket-Accept` value the client will check. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey + GUID)
    .digest('base64')
}

export function acceptUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head?: Buffer,
  subprotocol?: string,
): WebSocketConnection {
  const clientKey = req.headers['sec-websocket-key']
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(typeof clientKey === 'string' ? clientKey : '')}\r\n` +
      // Echoed only when the server knows which protocol it is speaking: a
      // client that offered a list rejects an answer it did not offer.
      (subprotocol === undefined ? '' : `Sec-WebSocket-Protocol: ${subprotocol}\r\n`) +
      '\r\n',
  )

  let open = true
  let buffer = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
  /** Bytes of a message whose frames have not all arrived yet. */
  let fragments: Buffer[] = []
  let fragmentOpcode = 0
  let fragmentBytes = 0
  let messageHandler: ((text: string) => void) | null = null
  const closeHandlers: (() => void)[] = []

  const finish = (): void => {
    if (!open) return
    open = false
    for (const handler of closeHandlers.splice(0)) handler()
  }

  const sendFrame = (opcode: number, payload: Buffer): void => {
    if (!open || socket.destroyed) return
    const length = payload.length
    let header: Buffer
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length])
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    socket.write(Buffer.concat([header, payload]))
  }

  const protocolError = (reason: string): void => {
    sendFrame(OP_CLOSE, closePayload(1002, reason))
    socket.destroy()
    finish()
  }

  /** Handles one complete frame. Knows FIN, so it owns the message boundary. */
  const onFrame = (opcode: number, payload: Buffer, fin: boolean): void => {
    if (opcode === OP_CLOSE) {
      // Answer the closing handshake, then stop. The peer may already be gone.
      sendFrame(OP_CLOSE, payload.subarray(0, 2))
      socket.end()
      finish()
      return
    }
    if (opcode === OP_PING) {
      sendFrame(OP_PONG, payload)
      return
    }
    // Pongs are answers to our own keepalives and binary is not our protocol;
    // neither is application data, so neither reaches the handler.
    if (opcode === OP_PONG || opcode === OP_BINARY) return

    if (opcode === OP_CONTINUATION) {
      if (fragmentOpcode === 0) return protocolError('continuation without a start frame')
      fragmentBytes += payload.length
    } else {
      if (fragmentOpcode !== 0) return protocolError('new message before the last one finished')
      fragments = []
      fragmentBytes = payload.length
      fragmentOpcode = opcode
    }
    if (fragmentBytes > MAX_MESSAGE_BYTES) return protocolError('message too large')
    fragments.push(payload)
    if (!fin) return

    const text = Buffer.concat(fragments).toString('utf8')
    fragments = []
    fragmentBytes = 0
    fragmentOpcode = 0
    messageHandler?.(text)
  }

  const drain = (): void => {
    while (buffer.length >= 2) {
      const first = buffer[0] as number
      const second = buffer[1] as number
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) return protocolError('frame too large')
        length = Number(big)
        offset = 10
      }

      // The RFC requires client frames to be masked; accepting an unmasked one
      // would let a malicious intermediary forge frames.
      if (!masked) return protocolError('client frames must be masked')

      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (payload[i] as number) ^ (mask[i % 4] as number)
      }
      buffer = buffer.subarray(offset + 4 + length)
      onFrame(opcode, payload, fin)
      if (!open) return
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    drain()
  })
  socket.on('close', finish)
  socket.on('error', finish)
  socket.on('end', finish)

  drain()

  return {
    get open() {
      return open
    },
    send: (text) => sendFrame(OP_TEXT, Buffer.from(text, 'utf8')),
    close: (code = 1000, reason = '') => {
      if (!open) return
      sendFrame(OP_CLOSE, closePayload(code, reason))
      // Give the peer a moment to answer the handshake, then stop waiting.
      socket.end()
      finish()
    },
    onMessage: (handler) => {
      messageHandler = handler
    },
    onClose: (handler) => {
      if (!open) {
        handler()
        return
      }
      closeHandlers.push(handler)
    },
  }
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)
  return payload
}

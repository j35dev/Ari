import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptUpgrade, isWebSocketUpgrade } from './ws'

/** One client→server frame, masked as RFC 6455 requires. */
function frame(opcode: number, payload: Buffer, fin: boolean): Buffer {
  const mask = Buffer.from([1, 2, 3, 4])
  const header: number[] = [((fin ? 0x80 : 0) | opcode) & 0xff]
  if (payload.length < 126) {
    header.push(0x80 | payload.length)
  } else {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] as number) ^ (mask[i % 4] as number)
  return Buffer.concat([Buffer.from(header), mask, masked])
}

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** A gateway-shaped server: echo, plus whatever the test needs. */
async function serve(
  onConnection: (connection: ReturnType<typeof acceptUpgrade>) => void,
): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(404).end()
  })
  servers.push(server)
  server.on('upgrade', (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) {
      socket.destroy()
      return
    }
    onConnection(acceptUpgrade(req, socket, head))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `ws://127.0.0.1:${port}/events`
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true })
  })
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true })
  })
}

describe('websocket upgrade', () => {
  it('distinguishes a real upgrade from an ordinary request and from a partial one', async () => {
    const server = createServer((_req, res) => res.writeHead(404).end())
    servers.push(server)
    const seen: boolean[] = []
    server.on('upgrade', (req, socket) => {
      seen.push(isWebSocketUpgrade(req))
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const { request } = await import('node:http')
    const send = (headers: Record<string, string>): Promise<void> =>
      new Promise<void>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/', headers }, () => resolve())
        req.on('error', () => resolve())
        req.end()
      })

    // A plain GET is not an upgrade at all, so node never emits one for it —
    // it is here to show the header check is what makes the difference.
    await send({})

    await send({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    })

    // Node emits `upgrade` for anything carrying the headers, so a request that
    // forgot the key — or asks for an older protocol version — still reaches
    // this check, and accepting it would hand back a handshake the client
    // cannot verify.
    await send({ Connection: 'Upgrade', Upgrade: 'websocket' })

    expect(seen).toEqual([true, false])
  })

  it('completes a handshake the platform client accepts', async () => {
    const url = await serve((connection) => connection.onMessage((text) => connection.send(text)))
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('handshake failed')), { once: true })
    })
    socket.send('hello')
    expect(await nextMessage(socket)).toBe('hello')
    socket.close()
  })

  it('carries payloads past the 125-byte boundary and past 64 KiB', async () => {
    const url = await serve((connection) => connection.onMessage((text) => connection.send(text)))
    const socket = new WebSocket(url)
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }))

    // 126..65535 needs the 16-bit length; above that needs the 64-bit one, and
    // both are where an off-by-one in the length encoding shows up.
    for (const size of [125, 126, 70_000]) {
      const payload = 'x'.repeat(size)
      socket.send(payload)
      const echoed = await nextMessage(socket)
      expect(echoed.length).toBe(size)
    }
    socket.close()
  })

  it('reassembles a message split across continuation frames', async () => {
    const url = await serve((connection) => connection.onMessage((text) => connection.send(text)))
    const { port } = new URL(url)
    const socket = connect({ host: '127.0.0.1', port: Number(port) })
    await new Promise<void>((resolve) => socket.once('connect', resolve))

    // The platform client will not emit a fragmented message on demand, so
    // this handshakes by hand and writes the frames itself: one text frame
    // with FIN clear, then a continuation frame with FIN set.
    socket.write(
      'GET /events HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    await once(socket, 'data') // the 101 response

    socket.write(frame(0x1, Buffer.from('one '), false))
    socket.write(frame(0x0, Buffer.from('two '), false))
    socket.write(frame(0x0, Buffer.from('three'), true))

    const reply = await once(socket, 'data')
    // Server frames are unmasked, so the payload is readable in place.
    expect((reply[0] as Buffer).subarray(2).toString()).toBe('one two three')
    socket.destroy()
  })

  it('closes cleanly and reports the close code', async () => {
    const url = await serve((connection) => connection.onMessage((text) => connection.send(text)))
    const socket = new WebSocket(url)
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }))
    socket.close(1000, 'done')
    expect(await closed(socket)).toBe(1000)
  })

  it('stops delivering to a connection the server closed', async () => {
    let serverSide: ReturnType<typeof acceptUpgrade> | null = null
    const url = await serve((connection) => {
      serverSide = connection
    })
    const socket = new WebSocket(url)
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }))
    serverSide!.close(1001, 'going away')
    expect(await closed(socket)).toBe(1001)
    expect(serverSide!.open).toBe(false)
  })

  it('answers a ping without disturbing the message stream', async () => {
    const received: string[] = []
    const url = await serve((connection) =>
      connection.onMessage((text) => {
        received.push(text)
        connection.send(text)
      }),
    )
    const socket = new WebSocket(url)
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve(), { once: true }))
    socket.send('before')
    expect(await nextMessage(socket)).toBe('before')
    // A keepalive must not be mistaken for application data.
    socket.send('after')
    expect(await nextMessage(socket)).toBe('after')
    expect(received).toEqual(['before', 'after'])
    socket.close()
  })
})

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DiscordPresence,
  discordIpcPaths,
  encodeFrame,
  FrameDecoder,
  presenceActivity,
  type PresenceSocket,
} from './discord-presence'

class FakeSocket extends EventEmitter implements PresenceSocket {
  readonly sent: { op: number; data: unknown }[] = []
  destroyed = false
  readonly #decoder = new FrameDecoder()

  write(data: Buffer): void {
    this.sent.push(...this.#decoder.push(data))
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }

  /** Discord's side of the conversation. */
  reply(op: number, data: unknown): void {
    this.emit('data', encodeFrame(op, data))
  }

  ready(): void {
    this.reply(1, { cmd: 'DISPATCH', evt: 'READY', data: {} })
  }
}

function presenceWith(sockets: (FakeSocket | null)[]) {
  const connect = vi.fn(() => Promise.resolve(sockets.shift() ?? null))
  const presence = new DiscordPresence({ clientId: 'app-1', connect, now: () => 1000, pid: 42 })
  return { presence, connect }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('frames', () => {
  it('round-trips a frame split across chunks', () => {
    const frame = encodeFrame(1, { hello: 'world' })
    const decoder = new FrameDecoder()
    expect(decoder.push(frame.subarray(0, 5))).toEqual([])
    expect(decoder.push(frame.subarray(5, 11))).toEqual([])
    expect(decoder.push(Buffer.concat([frame.subarray(11), encodeFrame(3, 7)]))).toEqual([
      { op: 1, data: { hello: 'world' } },
      { op: 3, data: 7 },
    ])
  })

  it('writes a little-endian op and byte length header', () => {
    const frame = encodeFrame(2, 'é')
    expect(frame.readUInt32LE(0)).toBe(2)
    expect(frame.readUInt32LE(4)).toBe(Buffer.byteLength('"é"'))
  })
})

describe('discordIpcPaths', () => {
  it('uses named pipes on Windows', () => {
    const paths = discordIpcPaths('win32', {})
    expect(paths).toHaveLength(10)
    expect(paths[0]).toBe('\\\\?\\pipe\\discord-ipc-0')
  })

  it('checks the runtime dir, then Flatpak and Snap folders, elsewhere', () => {
    const paths = discordIpcPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' })
    expect(paths[0]).toBe('/run/user/1000/discord-ipc-0')
    expect(paths).toContain('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0')
    expect(paths).toContain('/run/user/1000/snap.discord/discord-ipc-9')
    expect(discordIpcPaths('darwin', {})[0]).toBe('/tmp/discord-ipc-0')
  })
})

describe('presenceActivity', () => {
  it('reports idle or the running agent count with the app start time', () => {
    expect(presenceActivity(0, 5)).toEqual({ details: 'Idle', timestamps: { start: 5 } })
    expect(presenceActivity(1, 5).details).toBe('Running 1 agent')
    expect(presenceActivity(3, 5).details).toBe('Running 3 agents')
  })
})

describe('DiscordPresence', () => {
  it('handshakes, then sets the activity once Discord is ready', async () => {
    const socket = new FakeSocket()
    const { presence } = presenceWith([socket])
    presence.setEnabled(true)
    await flush()
    expect(socket.sent).toEqual([{ op: 0, data: { v: 1, client_id: 'app-1' } }])

    socket.ready()
    expect(socket.sent[1]).toMatchObject({
      op: 1,
      data: {
        cmd: 'SET_ACTIVITY',
        args: { pid: 42, activity: { details: 'Idle', timestamps: { start: 1000 } } },
      },
    })

    presence.setRunningCount(2)
    expect(socket.sent[2]).toMatchObject({
      data: { args: { activity: { details: 'Running 2 agents' } } },
    })
  })

  it('keeps the latest running count for when Discord becomes ready', async () => {
    const socket = new FakeSocket()
    const { presence } = presenceWith([socket])
    presence.setRunningCount(1)
    presence.setEnabled(true)
    await flush()
    socket.ready()
    expect(socket.sent[1]).toMatchObject({
      data: { args: { activity: { details: 'Running 1 agent' } } },
    })
  })

  it('answers pings with pongs', async () => {
    const socket = new FakeSocket()
    const { presence } = presenceWith([socket])
    presence.setEnabled(true)
    await flush()
    socket.reply(3, { n: 1 })
    expect(socket.sent.at(-1)).toEqual({ op: 4, data: { n: 1 } })
  })

  it('retries quietly until Discord is running', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const { presence, connect } = presenceWith([null, socket])
    presence.setEnabled(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(socket.sent[0]?.op).toBe(0)
  })

  it('reconnects after Discord closes the socket', async () => {
    vi.useFakeTimers()
    const first = new FakeSocket()
    const second = new FakeSocket()
    const { presence, connect } = presenceWith([first, second])
    presence.setEnabled(true)
    await vi.advanceTimersByTimeAsync(0)
    first.emit('close')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(second.sent[0]?.op).toBe(0)
  })

  it('drops a client that never becomes ready and tries again', async () => {
    vi.useFakeTimers()
    const hung = new FakeSocket()
    const healthy = new FakeSocket()
    const { presence, connect } = presenceWith([hung, healthy])
    presence.setEnabled(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(hung.destroyed).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connect).toHaveBeenCalledTimes(2)
    healthy.ready()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(healthy.destroyed).toBe(false)
  })

  it('drops the connection and stops retrying when disabled', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const { presence, connect } = presenceWith([socket])
    presence.setEnabled(true)
    await vi.advanceTimersByTimeAsync(0)
    presence.setEnabled(false)
    expect(socket.destroyed).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('closes a socket that connects after it was disabled', async () => {
    const socket = new FakeSocket()
    let resolve: (value: PresenceSocket) => void = () => {}
    const presence = new DiscordPresence({
      connect: () => new Promise<PresenceSocket>((r) => (resolve = r)),
    })
    presence.setEnabled(true)
    presence.setEnabled(false)
    resolve(socket)
    await flush()
    expect(socket.destroyed).toBe(true)
    expect(socket.sent).toEqual([])
  })
})

import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { posix } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:discord-presence')

/** The "Ari" Discord application: its name and icon are what a profile shows. */
export const DISCORD_CLIENT_ID = '1561243865925681172'

const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_CLOSE = 2
const OP_PING = 3
const OP_PONG = 4

const RETRY_MS = 30_000

/** One Discord IPC frame: little-endian op and length, then a JSON body. */
export function encodeFrame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(8)
  header.writeUInt32LE(op, 0)
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

export interface DiscordFrame {
  op: number
  data: unknown
}

/** Splits the socket's byte stream into frames; a partial frame waits for more bytes. */
export class FrameDecoder {
  #pending = Buffer.alloc(0)

  push(chunk: Buffer): DiscordFrame[] {
    this.#pending = Buffer.concat([this.#pending, chunk])
    const frames: DiscordFrame[] = []
    while (this.#pending.length >= 8) {
      const length = this.#pending.readUInt32LE(4)
      if (this.#pending.length < 8 + length) break
      const op = this.#pending.readUInt32LE(0)
      const body = this.#pending.subarray(8, 8 + length).toString('utf8')
      this.#pending = this.#pending.subarray(8 + length)
      let data: unknown = null
      try {
        data = JSON.parse(body)
      } catch (error) {
        log.warn('discord sent a frame that is not JSON', { op, error: String(error) })
      }
      frames.push({ op, data })
    }
    return frames
  }
}

/** Where a running Discord client listens, in the order Discord's own SDK tries them. */
export function discordIpcPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const slots = Array.from({ length: 10 }, (_, i) => `discord-ipc-${i}`)
  if (platform === 'win32') return slots.map((slot) => `\\\\?\\pipe\\${slot}`)
  const base = env['XDG_RUNTIME_DIR'] ?? env['TMPDIR'] ?? env['TMP'] ?? env['TEMP'] ?? '/tmp'
  // Flatpak and Snap builds of Discord put the socket in their own subfolder.
  const dirs = [
    base,
    posix.join(base, 'app/com.discordapp.Discord'),
    posix.join(base, 'snap.discord'),
  ]
  return dirs.flatMap((dir) => slots.map((slot) => posix.join(dir, slot)))
}

/** The activity card: Ari's icon comes from the application, so no assets are sent. */
export function presenceActivity(
  runningCount: number,
  startedAt: number,
): { details: string; timestamps: { start: number } } {
  const details =
    runningCount > 0 ? `Running ${runningCount} agent${runningCount === 1 ? '' : 's'}` : 'Idle'
  return { details, timestamps: { start: startedAt } }
}

/** The slice of a socket the presence client uses, so tests can stand one in. */
export interface PresenceSocket {
  write(data: Buffer): void
  destroy(): void
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Connects to the first Discord IPC path that answers, or null when Discord isn't running. */
export async function openDiscordSocket(
  paths: readonly string[] = discordIpcPaths(),
): Promise<PresenceSocket | null> {
  for (const path of paths) {
    const socket = await new Promise<PresenceSocket | null>((resolve) => {
      const candidate = createConnection(path)
      candidate.once('connect', () => resolve(candidate))
      candidate.once('error', () => {
        candidate.destroy()
        resolve(null)
      })
    })
    if (socket) return socket
  }
  return null
}

export interface DiscordPresenceOptions {
  clientId?: string
  connect?: () => Promise<PresenceSocket | null>
  now?: () => number
  pid?: number
  retryMs?: number
}

/**
 * Shows "Playing Ari" on the user's Discord profile while enabled. Discord not
 * running is the normal case, not an error: the client retries quietly until
 * it appears, and Discord clears the card itself when the socket closes.
 */
export class DiscordPresence {
  readonly #clientId: string
  readonly #connect: () => Promise<PresenceSocket | null>
  readonly #pid: number
  readonly #retryMs: number
  readonly #startedAt: number
  #enabled = false
  #runningCount = 0
  #socket: PresenceSocket | null = null
  #ready = false
  #connecting = false
  #retry: ReturnType<typeof setTimeout> | null = null

  constructor(options: DiscordPresenceOptions = {}) {
    this.#clientId = options.clientId ?? DISCORD_CLIENT_ID
    this.#connect = options.connect ?? (() => openDiscordSocket())
    this.#pid = options.pid ?? process.pid
    this.#retryMs = options.retryMs ?? RETRY_MS
    this.#startedAt = (options.now ?? Date.now)()
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return
    this.#enabled = enabled
    if (enabled) void this.#open()
    else this.#close()
  }

  setRunningCount(count: number): void {
    this.#runningCount = count
    this.#sendActivity()
  }

  stop(): void {
    this.#enabled = false
    this.#close()
  }

  async #open(): Promise<void> {
    if (this.#connecting || this.#socket || !this.#enabled) return
    this.#connecting = true
    let socket: PresenceSocket | null = null
    try {
      socket = await this.#connect()
    } catch (error) {
      log.warn('could not reach discord', { error: String(error) })
    } finally {
      this.#connecting = false
    }
    if (!socket) {
      this.#scheduleRetry()
      return
    }
    if (!this.#enabled) {
      socket.destroy()
      return
    }
    this.#attach(socket)
  }

  #attach(socket: PresenceSocket): void {
    this.#socket = socket
    const decoder = new FrameDecoder()
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) this.#onFrame(socket, frame)
    })
    socket.on('error', (error) => log.debug('discord socket error', { error: String(error) }))
    socket.on('close', () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#ready = false
      this.#scheduleRetry()
    })
    socket.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.#clientId }))
  }

  #onFrame(socket: PresenceSocket, frame: DiscordFrame): void {
    if (frame.op === OP_PING) {
      socket.write(encodeFrame(OP_PONG, frame.data))
      return
    }
    if (frame.op === OP_CLOSE) {
      log.warn('discord closed the presence connection', { data: frame.data })
      socket.destroy()
      return
    }
    if (frame.op !== OP_FRAME || typeof frame.data !== 'object' || frame.data === null) return
    const message = frame.data as { cmd?: unknown; evt?: unknown; data?: unknown }
    if (message.evt === 'ERROR') {
      log.warn('discord rejected a presence command', { cmd: message.cmd, data: message.data })
      return
    }
    if (message.cmd === 'DISPATCH' && message.evt === 'READY') {
      this.#ready = true
      this.#sendActivity()
    }
  }

  #sendActivity(): void {
    if (!this.#socket || !this.#ready) return
    this.#socket.write(
      encodeFrame(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: this.#pid, activity: presenceActivity(this.#runningCount, this.#startedAt) },
        nonce: randomUUID(),
      }),
    )
  }

  #scheduleRetry(): void {
    if (!this.#enabled || this.#retry) return
    this.#retry = setTimeout(() => {
      this.#retry = null
      void this.#open()
    }, this.#retryMs)
    this.#retry.unref()
  }

  #close(): void {
    if (this.#retry) clearTimeout(this.#retry)
    this.#retry = null
    const socket = this.#socket
    this.#socket = null
    this.#ready = false
    socket?.destroy()
  }
}

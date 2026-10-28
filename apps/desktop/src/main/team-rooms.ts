import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BotStore } from '@ari/engine/bots'
import {
  ROOM_PASS,
  applyBotReply,
  createRoomState,
  roomPrompt,
  routeHumanMessage,
  type RoomBot,
  type RoomState,
} from '@ari/engine/room'
import type { SessionStore } from '@ari/engine/session-store'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:team-rooms')

export interface TeamRoomView extends RoomState {
  id: string
}

interface StoredRoom {
  id: string
  botIds: string[]
  state: RoomState
}

export interface TeamRoomDeps {
  /** JSON file the rooms survive a restart in. */
  path: string
  bots: Pick<BotStore, 'get'>
  store: Pick<SessionStore, 'load'>
  dispatch(
    command: Command,
    origin?: MessageOrigin,
  ): Promise<{ accepted: boolean; reason?: string }>
}

/**
 * The host side of a Hive team room. A human message wakes exactly one bot;
 * that bot's reply may hand the room to one teammate, and the host serializes
 * every wake so two bots never run at once. Each bot turn is a room-priority
 * held message, so a person's own turn always goes first.
 */
export class TeamRoomService {
  readonly #deps: TeamRoomDeps
  #rooms = new Map<string, TeamRoomView>()
  #ready: Promise<void> = Promise.resolve()
  #queue: Promise<void> = Promise.resolve()

  constructor(deps: TeamRoomDeps) {
    this.#deps = deps
  }

  load(): Promise<void> {
    this.#ready = this.#load()
    return this.#ready
  }

  async #load(): Promise<void> {
    let stored: StoredRoom[]
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#deps.path, 'utf8'))
      stored = Array.isArray(parsed) ? (parsed as StoredRoom[]) : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('team rooms file unreadable; starting empty', {
          path: this.#deps.path,
          error: String(error),
        })
      }
      stored = []
    }
    for (const room of stored) {
      if (
        typeof room?.id !== 'string' ||
        !Array.isArray(room?.botIds) ||
        room.state === null ||
        typeof room.state !== 'object'
      )
        continue
      const bots: RoomBot[] = []
      for (const botId of room.botIds) {
        const bot = await this.#deps.bots.get(botId)
        if (bot === null || bot.mainSessionId === undefined) continue
        bots.push({ botId: bot.id, name: bot.name, sessionId: bot.mainSessionId })
      }
      if (bots.length === 0) continue
      const known = new Set(bots.map((bot) => bot.botId))
      const state: RoomState = {
        ...room.state,
        bots,
        leadBotId:
          room.state.leadBotId !== null && known.has(room.state.leadBotId)
            ? room.state.leadBotId
            : null,
        activeBotId:
          room.state.activeBotId !== null && known.has(room.state.activeBotId)
            ? room.state.activeBotId
            : null,
        round:
          room.state.round === null
            ? null
            : {
                ...room.state.round,
                awaiting: (room.state.round.awaiting ?? []).filter((id) => known.has(id)),
                passed: (room.state.round.passed ?? []).filter((id) => known.has(id)),
              },
      }
      this.#rooms.set(room.id, { ...state, id: room.id })
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#deps.path), { recursive: true })
    const stored: StoredRoom[] = [...this.#rooms.values()].map((room) => {
      const { id, ...state } = room
      return { id, botIds: state.bots.map((bot) => bot.botId), state }
    })
    const temporary = `${this.#deps.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(stored), 'utf8')
    await rename(temporary, this.#deps.path)
  }

  async list(): Promise<TeamRoomView[]> {
    await this.#ready
    return [...this.#rooms.values()]
  }

  async create(input: {
    title: string
    botIds: string[]
    leadBotId?: string | null
  }): Promise<TeamRoomView> {
    await this.#ready
    const title = input.title.trim()
    if (title.length === 0) throw new Error('room title is empty')
    const botIds = [...new Set(input.botIds)]
    if (botIds.length === 0) throw new Error('a room needs at least one bot')
    const bots: RoomBot[] = []
    for (const botId of botIds) {
      const bot = await this.#deps.bots.get(botId)
      if (bot === null) throw new Error(`unknown bot: ${botId}`)
      if (bot.mainSessionId === undefined) throw new Error(`${bot.name} has no main session`)
      bots.push({ botId: bot.id, name: bot.name, sessionId: bot.mainSessionId })
    }
    const state = createRoomState(title, bots, input.leadBotId ?? null)
    const room: TeamRoomView = { ...state, id: `room_${randomUUID()}` }
    this.#rooms.set(room.id, room)
    await this.#save()
    return room
  }

  /** Routes a human message and wakes the first addressed bot. */
  send(roomId: string, text: string): Promise<{ targets: string[]; pick: boolean }> {
    return this.#serialize(() => this.#send(roomId, text))
  }

  async #send(roomId: string, text: string): Promise<{ targets: string[]; pick: boolean }> {
    await this.#ready
    const room = this.#rooms.get(roomId)
    if (room === undefined) throw new Error('unknown room')
    const content = text.trim()
    if (content.length === 0) throw new Error('room message is empty')
    const route = routeHumanMessage(room, content)
    this.#rooms.set(roomId, { ...route.state, id: roomId })
    await this.#save()
    if (route.targets.length > 0) await this.#wake(roomId, route.targets[0] as string)
    return { targets: route.targets, pick: route.pick }
  }

  /**
   * Called after every settle. Only a room turn can move the room on: a human
   * turn in the bot's own thread, or a turn from another room, is ignored.
   */
  onSettled(sessionId: string, turnId: string): Promise<void> {
    return this.#serialize(() => this.#onSettled(sessionId, turnId))
  }

  async #onSettled(sessionId: string, turnId: string): Promise<void> {
    await this.#ready
    for (const room of this.#rooms.values()) {
      const waiting = room.round?.awaiting[0]
      if (waiting === undefined) continue
      const bot = room.bots.find((entry) => entry.botId === waiting)
      if (bot === undefined || bot.sessionId !== sessionId) continue
      const model = await this.#deps.store.load(sessionId)
      const prompt = model.messages.find(
        (message) => message.role === 'user' && message.turnId === turnId,
      )
      if (prompt?.origin?.kind !== 'room' || prompt.origin.roomId !== room.id) continue
      const text = model.messages
        .filter((message) => message.role === 'assistant' && message.turnId === turnId)
        .flatMap((message) =>
          message.parts.filter((part) => part.type === 'text').map((part) => part.text),
        )
        .join('\n')
        .trim()
      await this.#record(room.id, waiting, text)
      return
    }
  }

  /** Room mutations run one at a time, so a settle never interleaves a send. */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async #record(roomId: string, botId: string, text: string): Promise<void> {
    const room = this.#rooms.get(roomId)
    if (room === undefined) return
    const reply = applyBotReply(room, botId, text.length === 0 ? ROOM_PASS : text)
    this.#rooms.set(roomId, { ...reply.state, id: roomId })
    await this.#save()
    if (reply.next !== null) await this.#wake(roomId, reply.next)
  }

  async #wake(roomId: string, botId: string): Promise<void> {
    const room = this.#rooms.get(roomId)
    if (room === undefined) return
    const bot = room.bots.find((entry) => entry.botId === botId)
    if (bot === undefined) return
    const outcome = await this.#deps.dispatch(
      {
        type: 'message.enqueue',
        sessionId: bot.sessionId,
        text: roomPrompt(room, botId),
        attachments: [],
        hold: true,
        priority: 'room',
      },
      { kind: 'room', roomId, botId },
    )
    if (outcome.accepted) return
    log.warn('team room wake was refused', { roomId, botId, reason: outcome.reason })
    // A bot that cannot be woken passes: the room must settle instead of
    // waiting forever on a session that may have been destroyed.
    await this.#record(roomId, botId, ROOM_PASS)
  }
}

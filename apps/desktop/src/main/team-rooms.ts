import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Bot } from '@ari/contracts/bot'
import type { TeamRoomFrame, TeamRoomSummary } from '@ari/contracts/rpc'
import type { BotStore } from '@ari/engine/bots'
import {
  ROOM_PASS,
  applyBotReply,
  createRoomState,
  roomPrompt,
  routeHumanMessage,
  type RoomBot,
  type RoomStamp,
  type RoomState,
} from '@ari/engine/room'
import type { SessionStore } from '@ari/engine/session-store'
import type { Command } from '@ari/contracts/commands'
import type { MessageOrigin } from '@ari/contracts/message'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:team-rooms')

/** How a bot looks in a room, read from its record. */
type BotFace = Pick<Bot, 'emoji' | 'character'>

interface Room {
  id: string
  state: RoomState
  /** Bot id → face. */
  faces: Record<string, BotFace>
  updatedAt: number
}

interface StoredRoom {
  id: string
  botIds: string[]
  /** Bot id → room thread. Rooms saved before threads existed have none. */
  threads?: Record<string, string>
  state: RoomState
  updatedAt?: number
}

/** What a bot's room thread is created with; the permission mode is the host's default. */
export interface RoomThreadInput {
  projectId: string
  title: string
  driverKind: Bot['driverKind']
  modelId: string | null
  botId: string
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
  /** Creates one bot's thread for a room and returns its session id. */
  createThread(input: RoomThreadInput): Promise<string>
  /** Archives a room thread once its room is removed. */
  archiveThread(sessionId: string): Promise<void>
  /** Called after every persisted change, and with `room: null` on removal. */
  publish(frame: TeamRoomFrame): void
  now?: () => number
}

/**
 * The host side of a Hive team room. A human message wakes exactly one bot;
 * replies may hand the room to teammates, and the host serializes every wake
 * so two bots never run at once. Each bot runs in its own room thread, and
 * each bot turn is a room-priority held message, so a person's own turn always
 * goes first.
 */
export class TeamRoomService {
  readonly #deps: TeamRoomDeps
  readonly #now: () => number
  #rooms = new Map<string, Room>()
  #ready: Promise<void> = Promise.resolve()
  #queue: Promise<void> = Promise.resolve()

  constructor(deps: TeamRoomDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
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
      const faces: Record<string, BotFace> = {}
      for (const botId of room.botIds) {
        const bot = await this.#deps.bots.get(botId)
        if (bot === null) continue
        // A missing thread is created on the bot's first wake; the main
        // session is never borrowed.
        bots.push({ botId: bot.id, name: bot.name, sessionId: room.threads?.[bot.id] ?? '' })
        faces[bot.id] = faceOf(bot)
      }
      if (bots.length === 0) continue
      const known = new Set(bots.map((bot) => bot.botId))
      const keep = (id: string | null): string | null => (id !== null && known.has(id) ? id : null)
      const round = room.state.round
      const state: RoomState = {
        ...room.state,
        bots,
        leadBotId: keep(room.state.leadBotId),
        activeBotId: keep(room.state.activeBotId),
        window: Array.isArray(room.state.window) ? room.state.window : [],
        log: Array.isArray(room.state.log) ? room.state.log : [],
        pending: Array.isArray(room.state.pending) ? room.state.pending : [],
        round:
          round === null || round === undefined
            ? null
            : {
                ...round,
                awaiting: (round.awaiting ?? []).filter((id) => known.has(id)),
                passed: (round.passed ?? []).filter((id) => known.has(id)),
                mentioned: (round.mentioned ?? []).filter((id) => known.has(id)),
              },
      }
      this.#rooms.set(room.id, {
        id: room.id,
        state,
        faces,
        updatedAt: room.updatedAt ?? this.#now(),
      })
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#deps.path), { recursive: true })
    const stored: StoredRoom[] = [...this.#rooms.values()].map((room) => ({
      id: room.id,
      botIds: room.state.bots.map((bot) => bot.botId),
      threads: Object.fromEntries(
        room.state.bots
          .filter((bot) => bot.sessionId.length > 0)
          .map((bot) => [bot.botId, bot.sessionId]),
      ),
      state: room.state,
      updatedAt: room.updatedAt,
    }))
    const temporary = `${this.#deps.path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(stored), 'utf8')
    await rename(temporary, this.#deps.path)
  }

  /** Persists a room change and tells the shell about it. */
  async #commit(id: string, state: RoomState): Promise<void> {
    const room = this.#rooms.get(id)
    if (room === undefined) return
    const next: Room = { ...room, state, updatedAt: this.#now() }
    this.#rooms.set(id, next)
    await this.#save()
    this.#deps.publish({ roomId: id, room: summarize(next) })
  }

  async list(): Promise<TeamRoomSummary[]> {
    await this.#ready
    return [...this.#rooms.values()].map(summarize)
  }

  /** Creates the room and one dedicated thread per bot, so room turns stay out of main sessions. */
  create(input: {
    title: string
    botIds: string[]
    leadBotId?: string | null
  }): Promise<TeamRoomSummary> {
    return this.#serialize(() => this.#create(input))
  }

  async #create(input: {
    title: string
    botIds: string[]
    leadBotId?: string | null
  }): Promise<TeamRoomSummary> {
    await this.#ready
    const title = input.title.trim()
    if (title.length === 0) throw new Error('room title is empty')
    const botIds = [...new Set(input.botIds)]
    if (botIds.length === 0) throw new Error('a room needs at least one bot')
    const members: { bot: Bot; projectId: string }[] = []
    for (const botId of botIds) {
      const bot = await this.#deps.bots.get(botId)
      if (bot === null) throw new Error(`unknown bot: ${botId}`)
      const projectId = await this.#projectOf(bot)
      if (projectId === null) throw new Error(`${bot.name} has no project`)
      members.push({ bot, projectId })
    }
    const bots: RoomBot[] = []
    try {
      for (const { bot, projectId } of members) {
        const sessionId = await this.#deps.createThread(threadInput(bot, projectId, title))
        bots.push({ botId: bot.id, name: bot.name, sessionId })
      }
    } catch (error) {
      for (const bot of bots) await this.#archive(bot.sessionId)
      throw error
    }
    const room: Room = {
      id: `room_${randomUUID()}`,
      state: createRoomState(title, bots, input.leadBotId ?? null),
      faces: Object.fromEntries(members.map(({ bot }) => [bot.id, faceOf(bot)])),
      updatedAt: this.#now(),
    }
    this.#rooms.set(room.id, room)
    await this.#commit(room.id, room.state)
    return summarize(this.#rooms.get(room.id) ?? room)
  }

  /**
   * Routes a human message and wakes the first addressed bot. While a round
   * runs the message is queued instead; with `botId` that bot is addressed
   * directly.
   */
  send(
    roomId: string,
    text: string,
    botId?: string,
  ): Promise<{ targets: string[]; pick: boolean; queued: boolean }> {
    return this.#serialize(() => this.#send(roomId, text, botId))
  }

  async #send(
    roomId: string,
    text: string,
    botId: string | undefined,
  ): Promise<{ targets: string[]; pick: boolean; queued: boolean }> {
    await this.#ready
    const room = this.#rooms.get(roomId)
    if (room === undefined) throw new Error('unknown room')
    const content = text.trim()
    if (content.length === 0) throw new Error('room message is empty')
    if (botId !== undefined && !room.state.bots.some((bot) => bot.botId === botId)) {
      throw new Error(`unknown bot in this room: ${botId}`)
    }
    const route = routeHumanMessage(room.state, content, this.#stamp(), botId ?? null)
    await this.#commit(roomId, route.state)
    const first = route.targets[0]
    if (first !== undefined) await this.#wake(roomId, first)
    return { targets: route.targets, pick: route.pick, queued: route.queued }
  }

  /** Deletes the room and archives (never deletes) each bot's room thread. */
  remove(roomId: string): Promise<{ removed: boolean }> {
    return this.#serialize(() => this.#remove(roomId))
  }

  async #remove(roomId: string): Promise<{ removed: boolean }> {
    await this.#ready
    const room = this.#rooms.get(roomId)
    if (room === undefined) return { removed: false }
    this.#rooms.delete(roomId)
    await this.#save()
    this.#deps.publish({ roomId, room: null })
    for (const bot of room.state.bots) await this.#archive(bot.sessionId)
    return { removed: true }
  }

  /**
   * Copies a bot's edited name and face into every room it sits in, so the
   * roster shows it and mentions route by the new name. A rename is not room
   * activity, so `updatedAt` stays.
   */
  refreshBot(bot: Bot): Promise<void> {
    return this.#serialize(() => this.#refreshBot(bot))
  }

  async #refreshBot(bot: Bot): Promise<void> {
    await this.#ready
    const changed: Room[] = []
    for (const room of this.#rooms.values()) {
      const member = room.state.bots.find((entry) => entry.botId === bot.id)
      if (member === undefined) continue
      const face = faceOf(bot)
      if (member.name === bot.name && isDeepStrictEqual(room.faces[bot.id], face)) continue
      const next: Room = {
        ...room,
        state: {
          ...room.state,
          bots: room.state.bots.map((entry) =>
            entry.botId === bot.id ? { ...entry, name: bot.name } : entry,
          ),
        },
        faces: { ...room.faces, [bot.id]: face },
      }
      this.#rooms.set(room.id, next)
      changed.push(next)
    }
    if (changed.length === 0) return
    await this.#save()
    for (const room of changed) this.#deps.publish({ roomId: room.id, room: summarize(room) })
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
      const waiting = room.state.round?.awaiting[0]
      if (waiting === undefined) continue
      const bot = room.state.bots.find((entry) => entry.botId === waiting)
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
    const reply = applyBotReply(
      room.state,
      botId,
      text.length === 0 ? ROOM_PASS : text,
      this.#stamp(),
    )
    await this.#commit(roomId, reply.state)
    if (reply.next !== null) await this.#wake(roomId, reply.next)
  }

  async #wake(roomId: string, botId: string): Promise<void> {
    const sessionId = await this.#threadOf(roomId, botId)
    const room = this.#rooms.get(roomId)
    if (room === undefined || sessionId === null) {
      if (room !== undefined) await this.#record(roomId, botId, ROOM_PASS)
      return
    }
    let outcome: { accepted: boolean; reason?: string }
    try {
      outcome = await this.#deps.dispatch(
        {
          type: 'message.enqueue',
          sessionId,
          text: roomPrompt(room.state, botId),
          attachments: [],
          hold: true,
          priority: 'room',
        },
        { kind: 'room', roomId, botId },
      )
    } catch (error) {
      outcome = { accepted: false, reason: String(error) }
    }
    if (outcome.accepted) return
    log.warn('team room wake was refused', { roomId, botId, reason: outcome.reason })
    // A bot that cannot be woken passes: the room must settle instead of
    // waiting forever on a session that may have been destroyed.
    await this.#record(roomId, botId, ROOM_PASS)
  }

  /** The bot's room thread, created now for a room saved before threads existed. */
  async #threadOf(roomId: string, botId: string): Promise<string | null> {
    const room = this.#rooms.get(roomId)
    const member = room?.state.bots.find((entry) => entry.botId === botId)
    if (room === undefined || member === undefined) return null
    if (member.sessionId.length > 0) return member.sessionId
    try {
      const bot = await this.#deps.bots.get(botId)
      const projectId = bot === null ? null : await this.#projectOf(bot)
      if (bot === null || projectId === null) throw new Error('bot or its project is gone')
      const sessionId = await this.#deps.createThread(threadInput(bot, projectId, room.state.title))
      await this.#commit(roomId, {
        ...room.state,
        bots: room.state.bots.map((entry) =>
          entry.botId === botId ? { ...entry, sessionId } : entry,
        ),
      })
      return sessionId
    } catch (error) {
      log.warn('team room thread could not be created', { roomId, botId, error: String(error) })
      return null
    }
  }

  /** The bot's project, or its main session's for a bot saved before bots had one. */
  async #projectOf(bot: Bot): Promise<string | null> {
    if (bot.projectId !== undefined) return bot.projectId
    if (bot.mainSessionId === undefined) return null
    return (await this.#deps.store.load(bot.mainSessionId)).session?.projectId ?? null
  }

  async #archive(sessionId: string): Promise<void> {
    if (sessionId.length === 0) return
    try {
      await this.#deps.archiveThread(sessionId)
    } catch (error) {
      log.warn('team room thread could not be archived', { sessionId, error: String(error) })
    }
  }

  #stamp(): RoomStamp {
    return { id: `entry_${randomUUID()}`, at: this.#now() }
  }
}

function threadInput(bot: Bot, projectId: string, title: string): RoomThreadInput {
  return {
    projectId,
    title,
    driverKind: bot.driverKind,
    modelId: bot.modelId,
    botId: bot.id,
  }
}

function faceOf(bot: Bot): BotFace {
  return { emoji: bot.emoji, ...(bot.character !== undefined ? { character: bot.character } : {}) }
}

function summarize(room: Room): TeamRoomSummary {
  const { state } = room
  return {
    id: room.id,
    title: state.title,
    bots: state.bots.map((bot) => {
      const face = room.faces[bot.botId]
      return {
        botId: bot.botId,
        name: bot.name,
        emoji: face?.emoji ?? '',
        ...(face?.character !== undefined ? { character: face.character } : {}),
        sessionId: bot.sessionId,
      }
    }),
    leadBotId: state.leadBotId,
    activeBotId: state.activeBotId,
    needsUser: state.needsUser,
    window: state.window,
    log: state.log,
    pending: state.pending.length,
    round:
      state.round === null
        ? null
        : {
            rounds: state.round.rounds,
            messages: state.round.messages,
            followUps: state.round.followUps,
            awaiting: state.round.awaiting,
            passed: state.round.passed,
          },
    updatedAt: room.updatedAt,
  }
}

import type { Bot } from '@ari/contracts/bot'

/** Rounds one human message may start, counting the first wake. */
export const ROOM_MAX_ROUNDS = 3
/** Bot messages one human message may produce. */
export const ROOM_MAX_MESSAGES = 10
/** Bot-to-bot handoffs one human message may start. */
export const ROOM_MAX_FOLLOW_UPS = 2
/** The room window a bot sees, in messages. */
export const ROOM_WINDOW_MESSAGES = 20

/** A bot says this, alone, when it has nothing to add. */
export const ROOM_PASS = '(pass)'

export interface RoomBot {
  botId: string
  name: string
  sessionId: string
}

export interface RoomEntry {
  /** Null for the person; a bot id for a bot. */
  botId: string | null
  text: string
}

export interface RoomRound {
  /** Wake waves so far, including the one the human message started. */
  rounds: number
  /** Bot messages in this human turn. */
  messages: number
  followUps: number
  /** Bots that still owe a reply, oldest first. */
  awaiting: string[]
  passed: string[]
}

export interface RoomState {
  title: string
  bots: RoomBot[]
  leadBotId: string | null
  /** The bot that last held the room: where an unaddressed message goes. */
  activeBotId: string | null
  /** A bot said `@user`; the roster shows a needs-you badge until a human replies. */
  needsUser: boolean
  window: RoomEntry[]
  round: RoomRound | null
}

export interface RoomRoute {
  state: RoomState
  /** Bots to wake in order. Empty when nobody can be addressed. */
  targets: string[]
  /** True when there is no active bot and no lead to fall back on. */
  pick: boolean
}

export interface RoomReply {
  state: RoomState
  /** The next bot to wake, or null when this wave is done. */
  next: string | null
  settled: boolean
}

/**
 * The room a bot team starts with: every bot, no lead, nobody active. A lead
 * is optional; without one an unaddressed first message asks the user to pick.
 */
export function createRoomState(
  title: string,
  bots: readonly RoomBot[],
  leadBotId: string | null = null,
): RoomState {
  return {
    title,
    bots: [...bots],
    leadBotId: bots.some((bot) => bot.botId === leadBotId) ? leadBotId : null,
    activeBotId: null,
    needsUser: false,
    window: [],
    round: null,
  }
}

/** Bot ids a human or bot text mentions, in the order they appear, unique. */
export function mentionedBotIds(text: string, bots: readonly Pick<Bot, 'id' | 'name'>[]): string[] {
  const byName = [...bots]
    .map((bot) => ({ id: bot.id, name: bot.name.trim() }))
    .filter((bot) => bot.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length)
  const found: { id: string; at: number }[] = []
  for (const bot of byName) {
    const pattern = new RegExp(`(?<![\\w@])@${escapeRegExp(bot.name)}(?![\\w-])`, 'i')
    const match = pattern.exec(text)
    if (match && !found.some((entry) => entry.id === bot.id))
      found.push({ id: bot.id, at: match.index })
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.id)
}

/** True when a bot text addresses the person rather than another bot. */
export function mentionsUser(text: string): boolean {
  return /(?<![\w@])@user(?![\w-])/i.test(text)
}

/**
 * Where a human message goes. An @mention wins; otherwise the bot that last
 * held the room, then the lead. Nobody is broadcast to: each reply is a full
 * coding-agent run, and a "thanks" must not start the whole team.
 */
export function routeHumanMessage(state: RoomState, text: string): RoomRoute {
  const window = capWindow([...state.window, { botId: null, text }])
  const mentioned = mentionedBotIds(
    text,
    state.bots.map((bot) => ({ id: bot.botId, name: bot.name })),
  )
  const known = new Set(state.bots.map((bot) => bot.botId))
  const active =
    state.activeBotId !== null && known.has(state.activeBotId) ? state.activeBotId : null
  const lead = state.leadBotId !== null && known.has(state.leadBotId) ? state.leadBotId : null
  const targets =
    mentioned.length > 0
      ? mentioned.slice(0, ROOM_MAX_MESSAGES)
      : active !== null
        ? [active]
        : lead !== null
          ? [lead]
          : []

  if (targets.length === 0) {
    return {
      state: { ...state, window, needsUser: false, round: null },
      targets: [],
      pick: true,
    }
  }

  const next: RoomState = {
    ...state,
    window,
    needsUser: false,
    activeBotId: targets[0] ?? null,
    round: {
      rounds: 1,
      messages: 0,
      followUps: 0,
      awaiting: targets,
      passed: [],
    },
  }
  return { state: next, targets, pick: false }
}

/**
 * Folds one bot reply back into the room. A pass is silent; a mention hands
 * the room to that bot while the round caps allow; otherwise the wave ends and
 * the room settles. The bot that spoke last (and did not pass) holds the room.
 */
export function applyBotReply(state: RoomState, botId: string, text: string): RoomReply {
  const round = state.round
  if (round === null || !round.awaiting.includes(botId)) {
    return { state, next: null, settled: false }
  }

  const pass = text.trim() === ROOM_PASS
  const window = capWindow(pass ? state.window : [...state.window, { botId, text }])
  const awaiting = round.awaiting.filter((id) => id !== botId)
  const passed = pass ? [...round.passed, botId] : round.passed
  const messages = round.messages + 1
  let rounds = round.rounds
  let followUps = round.followUps
  let targets = awaiting

  if (awaiting.length === 0) {
    const known = new Set(state.bots.map((bot) => bot.botId))
    const mentioned = mentionedBotIds(
      text,
      state.bots.map((bot) => ({ id: bot.botId, name: bot.name })),
    ).filter((id) => id !== botId && known.has(id) && !passed.includes(id))
    const withinCaps =
      mentioned.length > 0 &&
      rounds < ROOM_MAX_ROUNDS &&
      followUps < ROOM_MAX_FOLLOW_UPS &&
      messages < ROOM_MAX_MESSAGES
    if (withinCaps) {
      rounds += 1
      followUps += 1
      targets = mentioned.slice(0, ROOM_MAX_MESSAGES - messages)
    }
  }

  const activeBotId = pass ? state.activeBotId : botId
  const settled = targets.length === 0
  const next: RoomState = {
    ...state,
    window,
    activeBotId,
    needsUser: state.needsUser || mentionsUser(text),
    round: settled
      ? null
      : {
          rounds,
          messages,
          followUps,
          awaiting: targets,
          passed,
        },
  }
  return { state: next, next: targets[0] ?? null, settled }
}

/**
 * What a bot sees when the room wakes it: the recent window, with names, and
 * one instruction: answer in a single message, mention a teammate to hand off,
 * or pass.
 */
export function roomPrompt(state: RoomState, botId: string): string {
  const bot = state.bots.find((entry) => entry.botId === botId)
  const names = new Map(state.bots.map((entry) => [entry.botId, entry.name]))
  const lines = state.window.map((entry) => {
    const who = entry.botId === null ? 'User' : (names.get(entry.botId) ?? 'A bot')
    return `${who}: ${entry.text}`
  })
  const teammates = state.bots
    .filter((entry) => entry.botId !== botId)
    .map((entry) => `@${entry.name}`)
    .join(', ')
  return [
    `[Team room "${state.title}": you are ${bot?.name ?? 'a bot'}. Recent messages:]`,
    ...lines,
    '[Reply with one short message. ' +
      (teammates.length > 0 ? `Mention ${teammates} to hand off; ` : '') +
      `say ${ROOM_PASS} when you have nothing to add. Do not wait for a person to answer.]`,
  ].join('\n')
}

function capWindow(window: RoomEntry[]): RoomEntry[] {
  return window.length <= ROOM_WINDOW_MESSAGES
    ? window
    : window.slice(window.length - ROOM_WINDOW_MESSAGES)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

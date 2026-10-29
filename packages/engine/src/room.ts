import type { Bot } from '@ari/contracts/bot'

/** Rounds one human message may start, counting the first wake. */
export const ROOM_MAX_ROUNDS = 3
/** Bot messages one human message may produce. */
export const ROOM_MAX_MESSAGES = 10
/** Bot-to-bot handoffs one human message may start. */
export const ROOM_MAX_FOLLOW_UPS = 2
/** The room window a bot sees, in messages. */
export const ROOM_WINDOW_MESSAGES = 20
/** The room transcript kept for the shell, in messages. */
export const ROOM_LOG_MESSAGES = 500

/** A bot says this, alone, when it has nothing to add. */
export const ROOM_PASS = '(pass)'

export interface RoomBot {
  botId: string
  name: string
  /** The bot's own thread for this room, not its main session. */
  sessionId: string
}

export interface RoomEntry {
  /** Null for the person; a bot id for a bot. */
  botId: string | null
  text: string
}

/** One transcript line: a window entry with its identity and time. */
export interface RoomLogEntry extends RoomEntry {
  id: string
  at: number
}

/** Who and when a new transcript line gets; the caller owns ids and the clock. */
export interface RoomStamp {
  id: string
  at: number
}

/** A human message sent while a round ran; it starts its own turn once the room settles. */
export interface RoomPending {
  text: string
  /** The bot the person addressed directly, if any. */
  botId: string | null
}

export interface RoomRound {
  /** Wake waves so far, including the one the human message started. */
  rounds: number
  /** Bot messages in this human turn. */
  messages: number
  followUps: number
  /** Bots that still owe a reply in this wave, oldest first. */
  awaiting: string[]
  /** Bots that passed in this wave. */
  passed: string[]
  /** Teammates this wave's replies mentioned, in order: the next wave. */
  mentioned: string[]
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
  log: RoomLogEntry[]
  pending: RoomPending[]
  round: RoomRound | null
}

export interface RoomRoute {
  state: RoomState
  /** Bots to wake in order. Empty when nobody can be addressed or the message queued. */
  targets: string[]
  /** True when there is no active bot and no lead to fall back on. */
  pick: boolean
  /** True when a round was running, so the message waits for the room to settle. */
  queued: boolean
}

export interface RoomReply {
  state: RoomState
  /**
   * The next bot to wake, or null when the room is idle. After a settle this
   * is the first bot of the oldest queued human message's turn.
   */
  next: string | null
  /** The round this reply belonged to is over. */
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
    log: [],
    pending: [],
    round: null,
  }
}

/**
 * Bot ids a human or bot text mentions, in the order they appear, unique. The
 * longest name claims its text first, so `@Ada Lovelace` never also reads as
 * `@Ada`.
 */
export function mentionedBotIds(text: string, bots: readonly Pick<Bot, 'id' | 'name'>[]): string[] {
  const byName = [...bots]
    .map((bot) => ({ id: bot.id, name: bot.name.trim() }))
    .filter((bot) => bot.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length)
  const claimed: { from: number; to: number }[] = []
  const found: { id: string; at: number }[] = []
  for (const bot of byName) {
    const pattern = new RegExp(`(?<![\\w@])@${escapeRegExp(bot.name)}(?![\\w-])`, 'gi')
    for (const match of text.matchAll(pattern)) {
      const from = match.index
      const to = from + match[0].length
      if (claimed.some((span) => from < span.to && to > span.from)) continue
      claimed.push({ from, to })
      if (!found.some((entry) => entry.id === bot.id)) found.push({ id: bot.id, at: from })
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.id)
}

/** True when a bot text addresses the person rather than another bot. */
export function mentionsUser(text: string): boolean {
  return /(?<![\w@])@user(?![\w-])/i.test(text)
}

/** True for a reply that only passes: `(pass)`, `pass`, `(Pass).` and the like. */
export function isRoomPass(text: string): boolean {
  return /^\(?\s*pass\s*\)?[\s.!]*$/i.test(text.trim())
}

/**
 * Where a human message goes. A direct `botId` (the answer to a pick prompt)
 * wins, then an @mention, then the bot that last held the room, then the
 * lead. Nobody is broadcast to: each reply is a full coding-agent run, and a
 * "thanks" must not start the whole team. While a round runs the message is
 * posted but queued, so two bots never run at once and no reply is dropped.
 */
export function routeHumanMessage(
  state: RoomState,
  text: string,
  stamp: RoomStamp,
  botId: string | null = null,
): RoomRoute {
  // Answering a pick prompt re-sends the message that raised it; it is
  // already the newest line, so it is addressed rather than posted twice.
  const last = state.log[state.log.length - 1]
  const answersPick =
    botId !== null && state.round === null && last?.botId === null && last.text === text
  const posted = answersPick
    ? { ...state, needsUser: false }
    : { ...post(state, null, text, stamp), needsUser: false }
  if (state.round !== null) {
    return {
      state: { ...posted, pending: [...state.pending, { text, botId }] },
      targets: [],
      pick: false,
      queued: true,
    }
  }
  return { ...startTurn(posted, { text, botId }), queued: false }
}

/**
 * Folds one bot reply back into the room. A pass is silent; every mention in
 * the wave's replies joins the next wave while the round caps allow; once a
 * wave ends with nobody mentioned the room settles and the oldest queued human
 * message starts its turn. The bot that spoke last (and did not pass) holds
 * the room.
 */
export function applyBotReply(
  state: RoomState,
  botId: string,
  text: string,
  stamp: RoomStamp,
): RoomReply {
  const round = state.round
  if (round === null || !round.awaiting.includes(botId)) {
    return { state, next: null, settled: false }
  }

  const pass = isRoomPass(text)
  const awaiting = round.awaiting.filter((id) => id !== botId)
  const messages = round.messages + 1
  const known = new Set(state.bots.map((bot) => bot.botId))
  // A teammate still due in this wave reads the mention when it runs, so only
  // the others are handed the next wave.
  const mentioned = pass
    ? round.mentioned
    : unique([
        ...round.mentioned,
        ...mentionedBotIds(
          text,
          state.bots.map((bot) => ({ id: bot.botId, name: bot.name })),
        ).filter((id) => id !== botId && known.has(id) && !awaiting.includes(id)),
      ])

  let nextRound: RoomRound | null = null
  if (awaiting.length > 0) {
    nextRound = {
      ...round,
      messages,
      awaiting,
      passed: pass ? [...round.passed, botId] : round.passed,
      mentioned,
    }
  } else if (
    mentioned.length > 0 &&
    round.rounds < ROOM_MAX_ROUNDS &&
    round.followUps < ROOM_MAX_FOLLOW_UPS &&
    messages < ROOM_MAX_MESSAGES
  ) {
    nextRound = {
      rounds: round.rounds + 1,
      messages,
      followUps: round.followUps + 1,
      awaiting: mentioned.slice(0, ROOM_MAX_MESSAGES - messages),
      passed: [],
      mentioned: [],
    }
  }

  const replied: RoomState = {
    ...(pass ? state : post(state, botId, text, stamp)),
    activeBotId: pass ? state.activeBotId : botId,
    needsUser: state.needsUser || (!pass && mentionsUser(text)),
    round: nextRound,
  }
  const next = nextRound === null ? startPending(replied) : replied
  return { state: next, next: next.round?.awaiting[0] ?? null, settled: nextRound === null }
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

/** Starts a human turn for a message already in the window and the log. */
function startTurn(
  state: RoomState,
  message: RoomPending,
): { state: RoomState; targets: string[]; pick: boolean } {
  const known = new Set(state.bots.map((bot) => bot.botId))
  const direct = message.botId !== null && known.has(message.botId) ? message.botId : null
  const mentioned = mentionedBotIds(
    message.text,
    state.bots.map((bot) => ({ id: bot.botId, name: bot.name })),
  )
  const active =
    state.activeBotId !== null && known.has(state.activeBotId) ? state.activeBotId : null
  const lead = state.leadBotId !== null && known.has(state.leadBotId) ? state.leadBotId : null
  const targets =
    direct !== null
      ? [direct]
      : mentioned.length > 0
        ? mentioned.slice(0, ROOM_MAX_MESSAGES)
        : active !== null
          ? [active]
          : lead !== null
            ? [lead]
            : []

  if (targets.length === 0) {
    return { state: { ...state, round: null }, targets: [], pick: true }
  }
  return {
    state: {
      ...state,
      activeBotId: targets[0] ?? null,
      round: {
        rounds: 1,
        messages: 0,
        followUps: 0,
        awaiting: targets,
        passed: [],
        mentioned: [],
      },
    },
    targets,
    pick: false,
  }
}

/** Starts the oldest queued human message that can address somebody. */
function startPending(state: RoomState): RoomState {
  let next = state
  while (next.round === null && next.pending.length > 0) {
    const [first, ...rest] = next.pending as [RoomPending, ...RoomPending[]]
    next = startTurn({ ...next, pending: rest }, first).state
  }
  return next
}

function post(state: RoomState, botId: string | null, text: string, stamp: RoomStamp): RoomState {
  return {
    ...state,
    window: capTail([...state.window, { botId, text }], ROOM_WINDOW_MESSAGES),
    log: capTail([...state.log, { id: stamp.id, botId, text, at: stamp.at }], ROOM_LOG_MESSAGES),
  }
}

function capTail<T>(entries: T[], cap: number): T[] {
  return entries.length <= cap ? entries : entries.slice(entries.length - cap)
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

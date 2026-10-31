import { useSyncExternalStore } from 'react'

/**
 * Unread state for the Hive roster, keyed by bot: the renderer remembers when
 * each bot's chat was last looked at, and a bot with newer `updatedAt` is
 * unread until visited again. It lives in localStorage — "you have not seen
 * this" must survive a restart, or the dots lie about history.
 */
const STORAGE_KEY = 'ari.hive.seenBots.v1'
const listeners = new Set<() => void>()
let seen: Map<string, number> | null = null

/** Time the bot was last seen at, or null when it has never been visited. */
export function botSeenAt(botId: string): number | null {
  if (seen === null) {
    const raw = readStorage()
    seen = new Map(Object.entries(raw))
  }
  return seen.get(botId) ?? null
}

/** Records a visit right now and wakes every unread reader. */
export function markBotSeen(botId: string): void {
  const at = Date.now()
  botSeenAt(botId)
  seen?.set(botId, at)
  writeStorage(botId, at)
  for (const listener of listeners) listener()
}

/** True while the bot has news newer than the last visit. */
export function botUnread(botId: string, updatedAt: number | undefined): boolean {
  if (updatedAt === undefined) return false
  const at = botSeenAt(botId)
  return at !== null && updatedAt > at
}

/** Live `botUnread` for components; re-renders when a visit lands. */
export function useBotUnread(botId: string, updatedAt: number | undefined): boolean {
  return useSyncExternalStore(subscribe, () => botUnread(botId, updatedAt))
}

/** Test helper: forgets the in-memory cache so the next read re-loads
 * localStorage, like a reload does. */
export function forgetSeenBots(): void {
  seen = null
  for (const listener of listeners) listener()
}

/** Test helper: forgets everything, memory and localStorage, between tests. */
export function resetSeenBots(): void {
  seen = null
  window.localStorage.removeItem(STORAGE_KEY)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function readStorage(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([botId, value]) =>
        typeof value === 'number' ? [[botId, value]] : [],
      ),
    )
  } catch {
    return {}
  }
}

function writeStorage(botId: string, at: number): void {
  try {
    const raw = { ...readStorage(), [botId]: at }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(raw))
  } catch {
    // A broken or full storage loses unread memory, never the chats.
  }
}

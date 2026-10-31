import { useSyncExternalStore } from 'react'

/**
 * Bot identity has no global store — several views read `bots.list` their own
 * way (`useBots`, `useBotOf`) — so writers announce with a bump and readers
 * re-read. A tiny version counter keeps this at one module, not one store.
 */
const listeners = new Set<() => void>()
let version = 0

/** Bumps the bot version, waking every `useBotOf` reader to re-read disk. */
export function botsChanged(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Re-renders when {@link botsChanged} fires; pair it with a re-fetch effect. */
export function useBotsVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

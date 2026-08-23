import type { JournalEvent } from '@ari/contracts/events'

/**
 * Tracks live turns from the engine's published journal events so
 * main-process surfaces (tray) can show how many sessions are mid-turn
 * without reaching into the engine. Journals replay outside this counter,
 * which is correct: no turn survives an app restart.
 */
export class RunningTurnCounter {
  readonly #active = new Map<string, Set<string>>()

  /** Number of currently active (mid-turn) turns across all sessions. */
  get count(): number {
    let total = 0
    for (const turns of this.#active.values()) total += turns.size
    return total
  }

  /** Feeds one journal event; returns true when the count changed. */
  push(event: JournalEvent): boolean {
    if (event.type === 'turn.started') {
      const turns = this.#active.get(event.sessionId) ?? new Set<string>()
      const added = !turns.has(event.turnId)
      turns.add(event.turnId)
      this.#active.set(event.sessionId, turns)
      return added
    }
    if (event.type === 'turn.settled') {
      const turns = this.#active.get(event.sessionId)
      if (!turns || !turns.delete(event.turnId)) return false
      if (turns.size === 0) this.#active.delete(event.sessionId)
      return true
    }
    return false
  }
}

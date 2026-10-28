/** One console message a page emitted, kept for the next `browser_snapshot`. */
export interface ConsoleEntry {
  level: 'verbose' | 'info' | 'warning' | 'error'
  text: string
  timestamp: number
  source?: string
}

/** Newest entries kept per tab; older ones are dropped. */
export const CONSOLE_BUFFER_MAX = 50

/** Longest message text kept, so one runaway log cannot flood a tool result. */
export const CONSOLE_TEXT_MAX = 500

const LEVELS: readonly ConsoleEntry['level'][] = ['verbose', 'info', 'warning', 'error']

/**
 * What Electron's `console-message` event reports. Current Electron names the
 * level; older builds reported 0 verbose, 1 info, 2 warning, 3 error.
 */
export interface ConsoleMessage {
  level: string | number
  message: string
  sourceUrl?: string
}

function levelName(level: string | number): ConsoleEntry['level'] {
  if (typeof level !== 'number') {
    return level === 'warning' || level === 'error' || level === 'info' ? level : 'verbose'
  }
  return LEVELS[Math.trunc(level)] ?? 'info'
}

/**
 * Per-tab console history. Cleared on navigation so a snapshot only shows what
 * the current page logged, and capped so a looping page cannot grow it forever.
 */
export class ConsoleBuffer {
  #entries: ConsoleEntry[] = []

  push(message: ConsoleMessage, now = Date.now()): void {
    const text =
      message.message.length > CONSOLE_TEXT_MAX
        ? `${message.message.slice(0, CONSOLE_TEXT_MAX - 3)}...`
        : message.message
    const source = message.sourceUrl?.trim()
    this.#entries.push({
      level: levelName(message.level),
      text,
      timestamp: now,
      ...(source ? { source } : {}),
    })
    if (this.#entries.length > CONSOLE_BUFFER_MAX) {
      this.#entries.splice(0, this.#entries.length - CONSOLE_BUFFER_MAX)
    }
  }

  entries(): ConsoleEntry[] {
    return [...this.#entries]
  }

  clear(): void {
    this.#entries = []
  }
}

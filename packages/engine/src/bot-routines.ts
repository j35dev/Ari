import type { SessionReadModel } from './projection'

/** The first slot strictly after `now`; missed slots are not replayed in a burst. */
export function nextFireAt(at: number, everyMs: number, now: number): number {
  if (now < at) return at
  return at + everyMs * (Math.floor((now - at) / everyMs) + 1)
}

/** What a routine-run turn says: nobody is at the keyboard to answer it. */
export function routineMessage(prompt: string): string {
  return `[Routine run: no user is present. Do this without asking questions or waiting for a reply, then end with a short report.]\n\n${prompt}`
}

/** The turn this routine most recently started, or null before its first fire. */
export function latestRoutineTurnId(model: SessionReadModel, routineId: string): string | null {
  for (let index = model.messages.length - 1; index >= 0; index--) {
    const message = model.messages[index]
    if (message?.turnId && message.origin?.kind === 'routine' && message.origin.routineId === routineId)
      return message.turnId
  }
  return null
}

/**
 * True while this routine's previous fire is still working or still waiting
 * for the bot's turn. A second fire is skipped rather than queued: the bot is
 * already going to do that work once, and two copies would race.
 */
export function routineIsPending(model: SessionReadModel, routineId: string): boolean {
  const queued = model.queuedMessages.some(
    (message) => message.origin?.kind === 'routine' && message.origin.routineId === routineId,
  )
  if (queued) return true
  const latest = latestRoutineTurnId(model, routineId)
  return latest !== null && model.activeTurnId === latest
}

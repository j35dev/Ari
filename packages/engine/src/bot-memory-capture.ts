import type { SessionReadModel } from './projection'

/** How soon after a memory capture the next one may fire for the same session. */
export const MEMORY_CAPTURE_MIN_EVERY_MS = 15 * 60_000

/**
 * The one-shot housekeeping prompt. It is dispatched with the
 * `memory-capture` origin after a settled bot turn, and asks the bot to save
 * durable facts with its memory tools, then finish without chat. The current
 * memory is inline so it can patch or remove what is already there instead of
 * adding a second copy.
 */
export function memoryCapturePrompt(currentMemory: string): string {
  return [
    '[Memory capture. This is housekeeping, not a work request',
    '— reply with no text at all. Call your memory tools',
    ' (memory.add / memory.patch / memory.remove) for anything from this session that is durable and worth carrying into every future session: conventions it chose, where things live, facts about the project and its people. Nothing worth keeping: finish immediately. Keep the memory small and unique — patch or remove an obsolete line rather than adding a second opinion of it.]',
    '',
    'Current memory:',
    '',
    currentMemory.trim() || '(empty)',
  ].join('\n')
}

/** The turn this session's most recent memory capture started, or null. */
export function latestCaptureTurnId(model: SessionReadModel): string | null {
  for (let index = model.messages.length - 1; index >= 0; index--) {
    const message = model.messages[index]
    if (message?.turnId && message.origin?.kind === 'memory-capture') return message.turnId
  }
  return null
}

/**
 * True when this bot session deserves a memory-capture turn: nothing is
 * running or already queued; a person or a room actually talked since the
 * last capture (routine chatter is not worth stirring memory over); and the
 * throttle since the last capture has passed.
 */
export function memoryCaptureDue(
  model: SessionReadModel,
  lastCapturedAtMs: number | undefined,
  now: number,
  minEveryMs = MEMORY_CAPTURE_MIN_EVERY_MS,
): boolean {
  if (model.activeTurnId !== null) return false
  if (model.queuedMessages.some((message) => message.origin?.kind === 'memory-capture')) {
    return false
  }
  const latest = latestCaptureTurnId(model)
  const since =
    latest === null
      ? -1
      : model.messages.findIndex(
          (message) => message.turnId === latest && message.origin?.kind === 'memory-capture',
        )
  const talked = model.messages.some(
    (message, index) =>
      index > since && (message.origin?.kind === 'human' || message.origin?.kind === 'room'),
  )
  if (!talked) return false
  return lastCapturedAtMs === undefined || now - lastCapturedAtMs >= minEveryMs
}

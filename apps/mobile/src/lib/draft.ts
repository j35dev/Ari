import { remoteCommandEnvelopeSchema } from '@ari/contracts/remote'

export interface PendingSubmission {
  key: string
  text: string
  mode: 'send' | 'queue' | 'steer'
  attachmentIds: string[]
}

/** Drafts are local to this tab and computer. They are restored, never automatically sent. */
export function readDraft(
  origin: string | null,
  sessionId: string,
  deviceId: string | null = null,
): string {
  try {
    return sessionStorage.getItem(draftKey(origin, sessionId, deviceId)) ?? ''
  } catch (error) {
    console.warn('Could not restore the mobile draft', error)
    return ''
  }
}

/** Persist draft text without attachment bytes or authentication credentials. */
export function writeDraft(
  origin: string | null,
  sessionId: string,
  text: string,
  deviceId: string | null = null,
): void {
  try {
    const key = draftKey(origin, sessionId, deviceId)
    if (text.length === 0) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, text)
  } catch (error) {
    console.warn('Could not save the mobile draft', error)
  }
}
function draftKey(origin: string | null, sessionId: string, deviceId: string | null): string {
  return `ari.draft:${origin ?? ''}:${deviceId ?? ''}:${sessionId}`
}

/** Recover an immutable submission receipt so a reload cannot create a second prompt. */
export function readPending(
  origin: string | null,
  deviceId: string | null,
  sessionId: string,
): PendingSubmission | null {
  try {
    const stored = sessionStorage.getItem(pendingKey(origin, deviceId, sessionId))
    if (stored === null) return null
    const parsed = remoteCommandEnvelopeSchema.safeParse(JSON.parse(stored) as unknown)
    if (!parsed.success) return null
    const command = parsed.data
    if (
      command.op !== 'session.prompt' &&
      command.op !== 'session.queue' &&
      command.op !== 'session.steer'
    )
      return null
    if (command.sessionId !== sessionId) return null
    return {
      key: command.idempotencyKey,
      text: command.text,
      mode:
        command.op === 'session.queue'
          ? 'queue'
          : command.op === 'session.steer'
            ? 'steer'
            : 'send',
      attachmentIds: 'attachmentIds' in command ? (command.attachmentIds ?? []) : [],
    }
  } catch (error) {
    console.warn('Could not restore the pending mobile submission', error)
    return null
  }
}

/** Save only the exact prepared command; restoring it always requires an explicit retry. */
export function writePending(
  origin: string | null,
  deviceId: string | null,
  sessionId: string,
  pending: PendingSubmission | null,
): boolean {
  try {
    const key = pendingKey(origin, deviceId, sessionId)
    if (pending === null) sessionStorage.removeItem(key)
    else
      sessionStorage.setItem(
        key,
        JSON.stringify({
          op:
            pending.mode === 'queue'
              ? 'session.queue'
              : pending.mode === 'steer'
                ? 'session.steer'
                : 'session.prompt',
          sessionId,
          text: pending.text,
          attachmentIds: pending.attachmentIds,
          clientCommandId: pending.key,
          idempotencyKey: pending.key,
        }),
      )
    return true
  } catch (error) {
    console.warn('Could not save the pending mobile submission', error)
    return false
  }
}
function pendingKey(origin: string | null, deviceId: string | null, sessionId: string): string {
  return `ari.pending:${origin ?? ''}:${deviceId ?? ''}:${sessionId}`
}

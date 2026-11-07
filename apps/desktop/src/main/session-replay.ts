import type { JournalEvent } from '@ari/contracts/events'
import type { SessionEventFrame } from '@ari/contracts/rpc'

/** The terminal path shared by every desktop session-history subscription. */
export async function streamSessionReplay(
  sessionId: string,
  replay: (onChunk: (events: JournalEvent[]) => void) => Promise<void>,
  send: (frame: SessionEventFrame) => void,
  warn: (error: unknown) => void,
  liveTurnId?: () => string | null,
): Promise<void> {
  let replayOutcome: NonNullable<SessionEventFrame['replayOutcome']> = 'complete'
  try {
    await replay((events) => send({ sessionId, events, replay: true }))
  } catch (error) {
    replayOutcome = 'incomplete'
    warn(error)
  } finally {
    send({
      sessionId,
      replayDone: true,
      replayOutcome,
      ...(liveTurnId ? { liveTurnId: liveTurnId() } : {}),
    })
  }
}

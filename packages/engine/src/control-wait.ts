import { ControlFailure } from '@ari/contracts/agent-control'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionReadModel } from './projection'

export interface WaitSource {
  load(id: string): Promise<SessionReadModel>
  subscribe(listener: (event: JournalEvent) => void): () => void
  /** Fires when the session is destroyed or otherwise gone. */
  onGone?(id: string, listener: () => void): () => void
}

export type WaitOutcome =
  | {
      status: 'settled'
      sessionId: string
      turnId: string
      stopReason: string
      settledAt: number
      latestAssistantText: string
    }
  | {
      status: 'idle'
      sessionId: string
      turnId: string | null
      stopReason?: string
      settledAt?: number
      latestAssistantText: string
    }
  | { status: 'timeout'; sessionId: string }
  | { status: 'destroyed'; sessionId: string }

/** Subscribes before reading, then reconciles buffered settles for the captured turn. */
export async function waitForTurn(
  source: WaitSource,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  if (signal?.aborted) throw new ControlFailure('wait_cancelled', 'Wait cancelled.')
  let target: string | null | undefined
  let resolve!: (result: WaitOutcome) => void
  let reject!: (error: Error) => void
  const result = new Promise<WaitOutcome>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Loading can fail before the returned promise is awaited.
  void result.catch(() => undefined)
  const settles: Extract<JournalEvent, { type: 'turn.settled' }>[] = []
  const complete = (event: Extract<JournalEvent, { type: 'turn.settled' }>): void => {
    resolve({
      status: 'settled',
      sessionId: id,
      turnId: event.turnId,
      stopReason: event.stopReason,
      settledAt: event.at,
    } as WaitOutcome)
  }
  const unsubscribe = source.subscribe((event) => {
    if (event.sessionId !== id || event.type !== 'turn.settled') return
    settles.push(event)
    if (target === event.turnId) complete(event)
  })
  const cancel = (): void => reject(new ControlFailure('wait_cancelled', 'Wait cancelled.'))
  const gone = (): void =>
    reject(new ControlFailure('session_not_found', 'Session not found.'))
  signal?.addEventListener('abort', cancel, { once: true })
  const unwatchGone = source.onGone?.(id, gone)
  const timer = setTimeout(
    () => reject(new ControlFailure('wait_timeout', 'Wait timed out.')),
    timeoutMs,
  )
  try {
    const state = await source.load(id)
    if (signal?.aborted) throw new ControlFailure('wait_cancelled', 'Wait cancelled.')
    if (!state.session) throw new ControlFailure('session_not_found', 'Session not found.')
    target = state.activeTurnId
    const captured = settles[0]
    if (target === null) {
      if (captured) complete(captured)
      else
        return {
          status: 'idle',
          sessionId: id,
          turnId: state.lastTurn?.turnId ?? null,
          stopReason: state.lastTurn?.stopReason,
          settledAt: state.lastTurn?.settledAt,
          latestAssistantText: assistantText(state, state.lastTurn?.turnId),
        }
    } else if (captured && captured.turnId !== target) {
      complete(captured)
    } else {
      const settled = settles.find((event) => event.turnId === target)
      if (settled) complete(settled)
    }
    const settledResult = await result
    if (settledResult.status !== 'settled') return settledResult
    return {
      ...settledResult,
      latestAssistantText: assistantText(await source.load(id), settledResult.turnId),
    }
  } catch (error) {
    if (error instanceof ControlFailure && error.code === 'session_not_found') {
      return { status: 'destroyed', sessionId: id }
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    unwatchGone?.()
    unsubscribe()
  }
}

function assistantText(state: SessionReadModel, turnId?: string): string {
  const message = [...state.messages]
    .reverse()
    .find((entry) => entry.role === 'assistant' && (!turnId || entry.turnId === turnId))
  return (
    message?.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .slice(0, 8000) ?? ''
  )
}

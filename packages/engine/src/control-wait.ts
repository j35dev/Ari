import { ControlFailure } from '@ari/contracts/agent-control'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionReadModel } from './projection'

export interface WaitSource {
  load(id: string): Promise<SessionReadModel>
  subscribe(listener: (event: JournalEvent) => void): () => void
}

/** Subscribes before reading, then reconciles buffered settles for the captured turn. */
export async function waitForTurn(
  source: WaitSource,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new ControlFailure('wait_cancelled', 'Wait cancelled.')
  let target: string | null | undefined
  let resolve!: (result: unknown) => void
  let reject!: (error: Error) => void
  const result = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Loading can fail before the returned promise is awaited.
  void result.catch(() => undefined)
  const settles: Extract<JournalEvent, { type: 'turn.settled' }>[] = []
  const complete = (event: Extract<JournalEvent, { type: 'turn.settled' }>): void => {
    resolve({
      sessionId: id,
      turnId: event.turnId,
      stopReason: event.stopReason,
      settledAt: event.at,
    })
  }
  const unsubscribe = source.subscribe((event) => {
    if (event.sessionId !== id || event.type !== 'turn.settled') return
    settles.push(event)
    if (target === event.turnId) complete(event)
  })
  const cancel = (): void => reject(new ControlFailure('wait_cancelled', 'Wait cancelled.'))
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(
    () => reject(new ControlFailure('wait_timeout', 'Wait timed out.')),
    timeoutMs,
  )
  try {
    const state = await source.load(id)
    if (signal?.aborted) throw new ControlFailure('wait_cancelled', 'Wait cancelled.')
    if (!state.session) throw new ControlFailure('session_not_found', 'Session not found.')
    target = state.activeTurnId
    if (target === null)
      return {
        sessionId: id,
        turnId: null,
        status: state.status,
        ...state.lastTurn,
        latestAssistantText: assistantText(state, state.lastTurn?.turnId),
      }
    const settled = settles.find((event) => event.turnId === target)
    if (settled) complete(settled)
    const settledResult = (await result) as {
      sessionId: string
      turnId: string
      stopReason: string
      settledAt: number
    }
    return {
      ...settledResult,
      latestAssistantText: assistantText(await source.load(id), settledResult.turnId),
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
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

import type { SessionReadModel } from '@ari/engine/projection'
import type { Command } from '@ari/contracts/commands'

export interface HandoffDeps {
  current(): boolean
  open(): Promise<{ sessionId: string }>
  load(sessionId: string): Promise<Pick<SessionReadModel, 'activeTurnId'> | null>
  dispatch(command: Command): Promise<{ accepted: boolean; reason?: string }>
}

export async function sendToAria(deps: HandoffDeps, text: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  const { sessionId } = await deps.open()
  if (!deps.current()) return
  const model = await deps.load(sessionId)
  if (!deps.current()) return
  if (!model) throw new Error('Could not load Aria. Try again.')
  // Enqueue also promotes to a turn when idle, so a settle racing this read is safe.
  const command: Command = {
    type: model.activeTurnId === null ? 'turn.start' : 'message.enqueue',
    sessionId,
    text: body,
    attachments: [],
  }
  let result = await deps.dispatch(command)
  if (
    !result.accepted &&
    command.type === 'turn.start' &&
    result.reason === 'a turn is already active' &&
    deps.current()
  ) {
    // Aria can start an automatic results turn between the read and dispatch.
    result = await deps.dispatch({ ...command, type: 'message.enqueue' })
  }
  if (!result.accepted) throw new Error(result.reason ?? 'Aria could not receive the message.')
}

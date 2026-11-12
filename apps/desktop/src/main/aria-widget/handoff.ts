import type { Command } from '@ari/contracts/commands'

export interface HandoffDeps {
  arm?(sessionId: string, text: string): Promise<unknown>
  current(): boolean
  open(): Promise<{ sessionId: string }>
  dispatch(command: Command): Promise<{ accepted: boolean; reason?: string }>
}

export async function sendToAria(deps: HandoffDeps, text: string): Promise<void> {
  const body = text.trim()
  if (!body) return
  const { sessionId } = await deps.open()
  if (!deps.current()) return
  // The dispatcher promotes an enqueue to a turn when Aria is idle.
  const command: Command = {
    type: 'message.enqueue',
    sessionId,
    text: body,
    attachments: [],
  }
  await deps.arm?.(sessionId, body)
  if (!deps.current()) return
  const result = await deps.dispatch(command)
  if (!result.accepted) throw new Error(result.reason ?? 'Aria could not receive the message.')
}

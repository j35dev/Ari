import { z } from 'zod'

/** Attribution only. Authorization comes from the host's current connector grants. */
export const externalSourceSchema = z
  .object({
    platform: z.literal('slack'),
    connectorId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(100),
    channelId: z.string().min(1).max(100),
    threadId: z.string().min(1).max(100),
    senderId: z.string().min(1).max(100),
  })
  .strict()
export type ExternalSource = z.infer<typeof externalSourceSchema>

export const externalRequestSchema = z
  .object({
    source: externalSourceSchema,
    text: z.string().trim().min(1).max(16_000),
  })
  .strict()
export type ExternalRequest = z.infer<typeof externalRequestSchema>

export type ExternalIntent =
  | { kind: 'prompt'; text: string; projectName?: string }
  | { kind: 'status' | 'stop' | 'help' }
  | { kind: 'answer'; text: string }

/** Only explicit controls are interpreted. Ordinary task language stays with the project agent. */
export function externalIntent(text: string): ExternalIntent {
  const trimmed = text.trim()
  const command = trimmed.toLowerCase()
  if (command === 'status' || command === 'stop' || command === 'help') return { kind: command }
  const answer = /^answer\s+([\s\S]+)$/i.exec(trimmed)
  if (answer) return { kind: 'answer', text: answer[1]!.trim() }
  const project = /^in\s+([^\n:]{1,200})\s*:\s*([\s\S]+)$/i.exec(trimmed)
  return project
    ? { kind: 'prompt', projectName: project[1]!.trim(), text: project[2]!.trim() }
    : { kind: 'prompt', text: trimmed }
}

export function externalThreadKey(source: ExternalSource): string {
  return JSON.stringify([source.connectorId, source.workspaceId, source.channelId, source.threadId])
}

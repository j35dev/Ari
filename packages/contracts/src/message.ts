import { z } from 'zod'
import { timestampSchema } from './common'

export const messageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof messageRoleSchema>

export const messageOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  /**
   * Written by Ari itself when delegated children finish: the text is a
   * delivery notice, and `sessionIds` names the children it reports on.
   */
  z.object({
    kind: z.literal('completion'),
    deliveryId: z.string().optional(),
    sessionIds: z.array(z.string().min(1)).min(1).max(32),
  }),
  /** A child's provider asked a question that its lead is being woken for. */
  z.object({
    kind: z.literal('question'),
    sessionId: z.string().min(1),
    inputId: z.string().min(1),
  }),
  /** A durable inbox notice starts a coordinator turn, without becoming an assignment. */
  z.object({
    kind: z.literal('coordination'),
    deliveryId: z.string().min(1),
    messageIds: z.array(z.string().min(1)).min(1).max(32),
  }),
  /**
   * Legacy, no longer produced: the removed Hive bots wrote `routine`,
   * `memory-capture`, and `room` origins. They stay so old journals still
   * replay — journal replay rejects lines that fail to parse.
   */
  z.object({ kind: z.literal('routine'), routineId: z.string().min(1) }),
  z.object({ kind: z.literal('memory-capture') }),
  z.object({
    kind: z.literal('room'),
    roomId: z.string().min(1),
    botId: z.string().min(1),
  }),
])
export type MessageOrigin = z.infer<typeof messageOriginSchema>

/**
 * Why a queued turn exists. Only `human` is produced now; `room` and
 * `routine` are legacy values from the removed Hive bots, kept so old
 * journals still replay. They still rank below a person's turn.
 */
export const wakePrioritySchema = z.enum(['human', 'room', 'routine'])
export type WakePriority = z.infer<typeof wakePrioritySchema>

export const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const thinkingPartSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
})

export const toolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  callId: z.string(),
  name: z.string(),
  /** JSON-encoded arguments as emitted by the provider. */
  argsJson: z.string(),
})

export const toolResultPartSchema = z.object({
  type: z.literal('tool-result'),
  callId: z.string(),
  resultJson: z.string(),
  isError: z.boolean(),
})

/**
 * A staged image attached to a user message. Carries the attachment ref only;
 * the bytes are fetched from the main process (`attachments.read`) when the
 * transcript renders the thumbnail.
 */
export const imagePartSchema = z.object({
  type: z.literal('image'),
  attachmentId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
})

export const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  thinkingPartSchema,
  toolCallPartSchema,
  toolResultPartSchema,
  imagePartSchema,
])
export type MessagePart = z.infer<typeof messagePartSchema>

export const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  role: messageRoleSchema,
  origin: messageOriginSchema.optional(),
  parts: z.array(messagePartSchema),
  createdAt: timestampSchema,
})
export type Message = z.infer<typeof messageSchema>

/**
 * Appends streamed parts to `parts` in place. A tool call whose id is already
 * there replaces that part instead: providers announce a call again once its
 * input is known, and it must stay one row.
 */
export function pushMessageParts(parts: MessagePart[], incoming: readonly MessagePart[]): void {
  for (const part of incoming) {
    if (part.type === 'tool-call') {
      let index = parts.length - 1
      while (index >= 0) {
        const prev = parts[index]
        if (prev?.type === 'tool-call' && prev.callId === part.callId) break
        index--
      }
      if (index >= 0) {
        parts[index] = part
        continue
      }
    }
    parts.push(part)
  }
}

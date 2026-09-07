import { z } from 'zod'
import { timestampSchema } from './common'

export const messageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof messageRoleSchema>

export const messageOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
])
export type MessageOrigin = z.infer<typeof messageOriginSchema>

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

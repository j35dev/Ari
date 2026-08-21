import { z } from 'zod'
import { timestampSchema } from './common'

export const messageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof messageRoleSchema>

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

export const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  thinkingPartSchema,
  toolCallPartSchema,
  toolResultPartSchema,
])
export type MessagePart = z.infer<typeof messagePartSchema>

export const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  role: messageRoleSchema,
  parts: z.array(messagePartSchema),
  createdAt: timestampSchema,
})
export type Message = z.infer<typeof messageSchema>

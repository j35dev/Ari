import { z } from 'zod'

/** Coordination is an inbox entry, not a queued assignment or an implicit reply. */
export const coordinationMessageSchema = z.object({
  messageId: z.string().min(1),
  senderSessionId: z.string().min(1),
  recipientSessionId: z.string().min(1),
  text: z.string(),
  createdAt: z.number(),
  status: z.enum(['pending', 'delivering', 'delivered', 'consumed', 'uncertain']),
  turnId: z.string().nullable(),
  consumedAt: z.number().nullable(),
  /** Provider request behind a system notice; resolution is separate from consumption. */
  request: z
    .object({
      kind: z.enum(['input', 'approval']),
      requestId: z.string().min(1),
      sourceTurnId: z.string().min(1),
      ownerSessionId: z.string().nullable(),
      resolvedAt: z.number().nullable(),
    })
    .optional(),
})
export type CoordinationMessage = z.infer<typeof coordinationMessageSchema>

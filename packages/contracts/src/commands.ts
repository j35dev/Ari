import { z } from 'zod'
import {
  driverKindSchema,
  permissionModeSchema,
} from './common'
import { attachmentRefSchema, MAX_ATTACHMENTS } from './attachments'

/**
 * A user turn needs text, images, or both: an images-only message (empty
 * text) is a legitimate "look at this", while empty + imageless sends
 * nothing and is rejected.
 */
function requiresTextOrAttachments(
  value: { text: string; attachments: { id: string }[] },
  ctx: z.RefinementCtx,
): void {
  if (value.text.trim().length === 0 && value.attachments.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'text or attachments required' })
  }
}

/**
 * Commands dispatched from the renderer to the engine. The engine validates
 * every payload with these schemas before acting; unknown or malformed
 * commands are rejected, never guessed.
 */
export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.create'),
    projectId: z.string(),
    title: z.string(),
    driverKind: driverKindSchema,
    modelId: z.string().nullable(),
    permissionMode: permissionModeSchema,
  }),
  z
    .object({
      type: z.literal('turn.start'),
      sessionId: z.string(),
      text: z.string(),
      attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
    })
    .superRefine(requiresTextOrAttachments),
  z
    .object({
      type: z.literal('message.enqueue'),
      sessionId: z.string(),
      text: z.string(),
      attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
    })
    .superRefine(requiresTextOrAttachments),
  z.object({ type: z.literal('turn.interrupt'), sessionId: z.string() }),
  z.object({
    type: z.literal('approval.respond'),
    sessionId: z.string(),
    approvalId: z.string(),
    decision: z.enum(['allow', 'deny', 'always-allow']),
  }),
  z.object({
    type: z.literal('input.respond'),
    sessionId: z.string(),
    inputId: z.string(),
    value: z.string(),
  }),
  z.object({
    type: z.literal('checkpoint.revert'),
    sessionId: z.string(),
    turnId: z.string(),
  }),
  z.object({
    type: z.literal('session.update'),
    sessionId: z.string(),
    driverKind: driverKindSchema.optional(),
    modelId: z.string().nullable().optional(),
    permissionMode: permissionModeSchema.optional(),
    effort: z.string().min(1).nullable().optional(),
    title: z.string().min(1).optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('session.destroy'),
    sessionId: z.string(),
  }),
])
export type Command = z.infer<typeof commandSchema>

/** Unique key for idempotent command receipts. */
export function commandKey(command: Command): string {
  return `${command.type}:${'sessionId' in command ? command.sessionId : '-'}`
}

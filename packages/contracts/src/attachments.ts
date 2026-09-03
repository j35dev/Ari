import { z } from 'zod'

/** Maximum images carried by one message (mirrors the composer's cap). */
export const MAX_ATTACHMENTS = 4

/** Maximum decoded bytes accepted for a single image (8MB). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** Ceiling on a base64 image payload crossing IPC (8MB decoded ≈ 10.7M chars). */
export const MAX_ATTACHMENT_BASE64_CHARS = 12_000_000

/**
 * One staged image, as referenced by commands, queued messages, and journal
 * events. The bytes live on disk in the main process keyed by `id`; only this
 * lightweight ref is journaled, so replaying history never replays megabytes.
 */
export const attachmentRefSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
})
export type AttachmentRef = z.infer<typeof attachmentRefSchema>

/**
 * A user message waiting behind the active turn. Text may be empty when the
 * message is images-only; attachments ride along so the follow-up turn still
 * delivers them to the agent.
 */
export const queuedMessageSchema = z.object({
  text: z.string(),
  attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
})
export type QueuedMessage = z.infer<typeof queuedMessageSchema>

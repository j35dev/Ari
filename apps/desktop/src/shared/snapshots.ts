import { z } from 'zod'
import { attachmentRefSchema } from '@ari/contracts/attachments'

/** Pending receipts point at Ari's existing attachment store; no duplicate image bytes. */
export const pendingSnapshotSchema = z.object({
  id: z.string().uuid(),
  attachment: attachmentRefSchema,
  capturedAt: z.number().int().nonnegative(),
  windowTitle: z.string().max(512),
  target: z.string().min(1).max(128).optional(),
  desktopFeedback: z.boolean().optional(),
})
export type PendingSnapshot = z.infer<typeof pendingSnapshotSchema>
export type SnapshotEvent = { type: 'captured' } | { type: 'error'; message: string }
export interface SnapshotStatus {
  supported: boolean
  registered: boolean
  error: string | null
}

export interface SnapshotBridge {
  status(): Promise<SnapshotStatus>
  pending(): Promise<PendingSnapshot[]>
  read(id: string): Promise<PendingSnapshot & { dataBase64: string }>
  target(id: string, target: string): Promise<string>
  acknowledge(id: string): Promise<void>
  destination(id: string, rectangle: SnapshotRectangle): Promise<void>
  suppress(suppressed: boolean): Promise<void>
  onEvent(callback: (event: SnapshotEvent) => void): () => void
}

export const snapshotRectangleSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().max(32768),
  height: z.number().positive().max(32768),
})
export type SnapshotRectangle = z.infer<typeof snapshotRectangleSchema>

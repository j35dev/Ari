import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { attachmentRefSchema, type AttachmentRef } from '@ari/contracts/attachments'
import { pickedElementSchema } from '@ari/contracts/rpc'
import type { BrowserPick } from '../browser/browser-picks'
import type { ReviewDraft } from '../changes/review-drafts'

export const RECOVERY_STORAGE_KEY = 'ari.composer-recovery'
const MAX_SESSIONS = 100
export const MAX_RECOVERIES = 20
const MAX_STORAGE_CHARS = 2 * 1024 * 1024

const metadataSchema = z.object({
  name: z.string().min(1).max(512),
  mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/),
  size: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024),
  lastModified: z.number().int().nonnegative(),
})
export type DraftFileMetadata = z.infer<typeof metadataSchema>
export interface DraftImage {
  metadata: DraftFileMetadata
  file?: File
  ref?: AttachmentRef
}

const imageSchema = z.object({ metadata: metadataSchema, ref: attachmentRefSchema.optional() })
const noteSchema = z.object({
  id: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().nullable(),
  text: z.string().max(8000),
  side: z.enum(['old', 'new']).optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  context: z.string().max(8000).optional(),
  comparisonId: z.string().max(128).optional(),
})
const pickSchema = z.object({
  id: z.string().min(1).max(128),
  element: pickedElementSchema.extend({
    url: z.string().max(4096),
    selector: z.string().max(4096),
    tag: z.string().max(128),
    text: z.string().max(8000),
    role: z.string().max(512).nullable(),
    ariaLabel: z.string().max(2000).nullable(),
    html: z.string().max(8000),
  }),
  imageIntent: imageSchema.optional(),
})
const deliverySchema = z.enum(['preparing', 'pending', 'unsent', 'uncertain', 'saved'])
export type DraftDelivery = z.infer<typeof deliverySchema>
export interface DurableRecovery {
  id: string
  text: string
  files: File[]
  images: DraftImage[]
  notes: readonly ReviewDraft[]
  picks: readonly BrowserPick[]
  delivery: DraftDelivery
  autoRestore?: boolean
  reattachRequired?: boolean
}

const recoverySchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(256 * 1024),
  images: z.array(imageSchema).max(4),
  notes: z.array(noteSchema).max(50),
  picks: z.array(pickSchema).max(20),
  delivery: deliverySchema,
  autoRestore: z.boolean().optional(),
  reattachRequired: z.boolean().optional(),
})
const sessionSchema = z.object({
  images: z.array(imageSchema).max(4),
  picks: z.array(pickSchema).max(20),
  recoveries: z.array(recoverySchema).max(MAX_RECOVERIES),
  delivery: z.enum(['uncertain']).optional(),
  reattachRequired: z.boolean().optional(),
})

export interface SessionDraftIntent {
  images: DraftImage[]
  picks: readonly BrowserPick[]
  recoveries: DurableRecovery[]
  delivery?: 'uncertain'
  /** Only live promises lock Send. Hydrated receipts never execute themselves. */
  pendingId?: string
  storageIssue?: boolean
  reattachRequired?: boolean
}
const cache = new Map<string, SessionDraftIntent>()
const deleted = new Set<string>()
const listeners = new Set<() => void>()
const empty = (): SessionDraftIntent => ({ images: [], picks: [], recoveries: [] })
let unreadable = false

export function imageIntent(file: File): DraftImage {
  return {
    file,
    metadata: {
      name: file.name,
      mimeType: file.type,
      size: file.size,
      lastModified: file.lastModified,
    },
  }
}

function hydratePick(pick: z.infer<typeof pickSchema>): BrowserPick {
  return { id: pick.id, element: pick.element, image: null, imageIntent: pick.imageIntent }
}

function load(): void {
  try {
    const raw = localStorage.getItem(RECOVERY_STORAGE_KEY)
    if (!raw) return
    unreadable = true
    if (raw.length > MAX_STORAGE_CHARS) return
    const envelope = z
      .object({
        version: z.literal(1),
        sessions: z.record(z.string().min(1).max(128), z.unknown()),
      })
      .safeParse(JSON.parse(raw))
    if (!envelope.success) return
    if (Object.keys(envelope.data.sessions).length > MAX_SESSIONS) return
    unreadable = false
    for (const [id, value] of Object.entries(envelope.data.sessions)) {
      if (cache.has(id) || deleted.has(id)) continue
      const parsed = sessionSchema.safeParse(value)
      if (!parsed.success) {
        cache.set(id, { ...empty(), reattachRequired: true })
        continue
      }
      cache.set(id, {
        images: parsed.data.images,
        picks: parsed.data.picks.map(hydratePick),
        delivery: parsed.data.delivery,
        reattachRequired: parsed.data.reattachRequired,
        recoveries: parsed.data.recoveries.map((entry) => ({
          ...entry,
          files: [],
          picks: entry.picks.map(hydratePick),
          // Staging had not dispatched. A lost acknowledgement may have committed.
          delivery:
            entry.delivery === 'pending'
              ? 'uncertain'
              : entry.delivery === 'preparing'
                ? 'unsent'
                : entry.delivery,
          autoRestore: false,
        })),
      })
    }
  } catch {
    // Storage can be corrupt or unavailable; the live cache remains authoritative.
  }
}

export function readSessionDraftIntent(sessionId: string): SessionDraftIntent {
  if (!cache.has(sessionId)) {
    if (sessionId) load()
    if (!cache.has(sessionId))
      cache.set(sessionId, { ...empty(), reattachRequired: Boolean(sessionId) && unreadable })
  }
  return cache.get(sessionId)!
}

export function subscribeDraftIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useSessionDraftIntent(sessionId: string): SessionDraftIntent {
  return useSyncExternalStore(subscribeDraftIntent, () => readSessionDraftIntent(sessionId))
}

function persistedImage(image: DraftImage): z.infer<typeof imageSchema> {
  return { metadata: image.metadata, ref: image.ref }
}
function persistedPick(pick: BrowserPick): z.infer<typeof pickSchema> {
  const element = { ...pick.element }
  // These are the same effective context limits used by formatElementContext.
  element.text = element.text.slice(0, 400)
  element.html = element.html.slice(0, 1500)
  try {
    const url = new URL(element.url)
    url.username = ''
    url.password = ''
    element.url = url.href
  } catch {
    /* The browser can pick from a non-URL document. */
  }
  return {
    id: pick.id,
    element,
    imageIntent: pick.imageIntent
      ? persistedImage(pick.imageIntent)
      : pick.image
        ? persistedImage(imageIntent(pick.image))
        : undefined,
  }
}

function persist(): boolean {
  try {
    const sessions = Object.create(null) as Record<string, unknown>
    for (const [id, state] of cache) {
      if (
        !id ||
        deleted.has(id) ||
        (!state.images.length &&
          !state.picks.length &&
          !state.recoveries.length &&
          !state.delivery &&
          !state.reattachRequired)
      )
        continue
      // Schema projection whitelists metadata/context. Never serialize File bytes,
      // object URLs, bridge credentials, or arbitrary objects from a tool result.
      const value = sessionSchema.parse({
        images: state.images.map(persistedImage),
        picks: state.picks.map(persistedPick),
        delivery: state.delivery,
        reattachRequired: state.reattachRequired,
        recoveries: state.recoveries.map((entry) => ({
          ...entry,
          images: entry.images.map(persistedImage),
          picks: entry.picks.map(persistedPick),
        })),
      })
      sessions[id] = value
    }
    if (Object.keys(sessions).length > MAX_SESSIONS) return false
    const raw = JSON.stringify({ version: 1, sessions })
    if (raw.length > MAX_STORAGE_CHARS) return false
    localStorage.setItem(RECOVERY_STORAGE_KEY, raw)
    return true
  } catch {
    return false
  }
}

export function updateSessionDraftIntent(
  sessionId: string,
  update: (current: SessionDraftIntent) => SessionDraftIntent,
): void {
  if (deleted.has(sessionId)) return
  cache.set(sessionId, update(readSessionDraftIntent(sessionId)))
  const saved = !sessionId || persist()
  for (const [id, state] of cache) {
    if (state.storageIssue !== !saved) cache.set(id, { ...state, storageIssue: !saved })
  }
  for (const listener of listeners) listener()
}

/** Called only once session destruction succeeds, including deleted descendants. */
export function deleteSessionDraftIntent(sessionId: string): void {
  load()
  deleted.add(sessionId)
  cache.set(sessionId, empty())
  persist()
  for (const listener of listeners) listener()
}

/** Simulates a renderer restart in deterministic component tests. */
export function dropDraftIntentMemory(): void {
  cache.clear()
  deleted.clear()
  unreadable = false
}

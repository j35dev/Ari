import { useCallback, useMemo, useState } from 'react'
import {
  imageIntent,
  readSessionDraftIntent,
  updateSessionDraftIntent,
  useSessionDraftIntent,
  type DraftImage,
} from './draft-recovery-store'

/** Maximum number of images held at once (M6.6). */
export const MAX_IMAGES = 4

/** Maximum accepted size in bytes for a single image (8MB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface UseImageAttachmentsResult {
  /** Accepted images in arrival order. */
  images: File[]
  intents: DraftImage[]
  replace: (images: DraftImage[]) => void
  removeIntentAt: (index: number) => void
  /** Add files from a paste/drop handler; non-images and oversized files are dropped. */
  addFiles: (files: FileList | File[]) => void
  /** Remove the image at `index`; out-of-range indices are a no-op. */
  removeAt: (index: number) => void
  /** Remove every image. */
  clear: () => void
}

/**
 * Composer image attachment state (M6.6): accepts `FileList`s or plain arrays
 * from paste/drop handlers, keeps only `image/*` files no larger than
 * {@link MAX_IMAGE_BYTES}, and never holds more than {@link MAX_IMAGES}.
 */
export function useImageAttachments(sessionId?: string): UseImageAttachmentsResult {
  const state = useSessionDraftIntent(sessionId ?? '')
  const [local, setLocal] = useState<DraftImage[]>([])
  const intents = sessionId ? state.images : local
  const images = useMemo(
    () => intents.flatMap((image) => (image.file ? [image.file] : [])),
    [intents],
  )
  const setImages = useCallback(
    (update: (prev: DraftImage[]) => DraftImage[]) => {
      if (sessionId)
        updateSessionDraftIntent(sessionId, (prev) => ({ ...prev, images: update(prev.images) }))
      else setLocal(update)
    },
    [sessionId],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      let incoming = Array.from(files)
      if (sessionId) {
        const picks = readSessionDraftIntent(sessionId).picks
        const restored = picks.map((pick) => {
          const missing = pick.imageIntent
          if (!missing || pick.image || missing.ref) return pick
          const index = incoming.findIndex(
            (file) =>
              file.name === missing.metadata.name &&
              file.size === missing.metadata.size &&
              file.type === missing.metadata.mimeType,
          )
          if (index < 0) return pick
          const file = incoming[index]!
          incoming = incoming.filter((_, i) => i !== index)
          return { ...pick, image: file, imageIntent: imageIntent(file) }
        })
        if (restored.some((pick, index) => pick !== picks[index]))
          updateSessionDraftIntent(sessionId, (prev) => ({ ...prev, picks: restored }))
      }
      setImages((prev) => {
        const accepted = incoming.filter(
          (file) => file.type.startsWith('image/') && file.size <= MAX_IMAGE_BYTES,
        )
        if (accepted.length === 0) return prev
        const next = [...prev]
        for (const file of accepted) {
          const missing = next.findIndex(
            (image) =>
              !image.file &&
              !image.ref &&
              image.metadata.name === file.name &&
              image.metadata.mimeType === file.type &&
              image.metadata.size === file.size,
          )
          if (missing >= 0) next[missing] = imageIntent(file)
          else if (next.length < MAX_IMAGES) next.push(imageIntent(file))
        }
        return next
      })
    },
    [sessionId, setImages],
  )

  const removeAt = useCallback(
    (index: number) => {
      setImages((prev) => {
        const files = prev.filter((image) => image.file)
        return prev.filter((image) => image !== files[index])
      })
    },
    [setImages],
  )

  const clear = useCallback(() => setImages(() => []), [setImages])
  const replace = useCallback((next: DraftImage[]) => setImages(() => next), [setImages])
  const removeIntentAt = useCallback(
    (index: number) => setImages((prev) => prev.filter((_, i) => i !== index)),
    [setImages],
  )

  return { images, intents, addFiles, removeAt, removeIntentAt, replace, clear }
}

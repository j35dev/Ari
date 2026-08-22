import { useCallback, useState } from 'react'

/** Maximum number of images held at once (M6.6). */
export const MAX_IMAGES = 4

/** Maximum accepted size in bytes for a single image (8MB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface UseImageAttachmentsResult {
  /** Accepted images in arrival order. */
  images: File[]
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
export function useImageAttachments(): UseImageAttachmentsResult {
  const [images, setImages] = useState<File[]>([])

  const addFiles = useCallback((files: FileList | File[]) => {
    setImages((prev) => {
      if (prev.length >= MAX_IMAGES) return prev
      const accepted = Array.from(files).filter(
        (file) => file.type.startsWith('image/') && file.size <= MAX_IMAGE_BYTES,
      )
      if (accepted.length === 0) return prev
      return [...prev, ...accepted].slice(0, MAX_IMAGES)
    })
  }, [])

  const removeAt = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const clear = useCallback(() => setImages([]), [])

  return { images, addFiles, removeAt, clear }
}

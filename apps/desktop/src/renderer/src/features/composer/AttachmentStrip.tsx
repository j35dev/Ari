import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

export interface AttachmentStripProps {
  /** Pending images to preview, in arrival order. */
  images: readonly File[]
  /** Called with the clicked thumbnail's index. */
  onRemove?: (index: number) => void
}

/**
 * Horizontal strip of pending image attachment thumbnails (M6.6). Each file
 * gets an object URL for its preview; URLs are revoked whenever the file set
 * changes or the strip unmounts. Renders nothing while empty.
 */
export function AttachmentStrip({ images, onRemove }: AttachmentStripProps) {
  const [urls, setUrls] = useState<string[]>([])

  useEffect(() => {
    const next = images.map((file) => URL.createObjectURL(file))
    setUrls(next)
    return () => {
      for (const url of next) URL.revokeObjectURL(url)
    }
  }, [images])

  if (images.length === 0) return null

  return (
    <div role="list" aria-label="Attached images" className="flex gap-2 overflow-x-auto py-1">
      {images.map((file, index) => (
        <div key={`${file.name}:${index}`} role="listitem" className="relative h-10 w-10 shrink-0">
          <img
            src={urls[index]}
            alt={file.name}
            title={file.name}
            className="h-10 w-10 rounded-md border border-border object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove?.(index)}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface-1 text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { rowAction } from '../../lib/recipes'

export interface AttachmentStripProps {
  /** Pending images to preview, in arrival order. */
  images: readonly File[]
  /** Called with the clicked thumbnail's index. */
  onRemove?: (index: number) => void
}

/**
 * Pending image attachments as quiet chips: thumbnail, file name, remove
 * (M6.6). Each file gets an object URL for its preview; URLs are revoked
 * whenever the file set changes or the strip unmounts. Renders nothing while
 * empty.
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
    <div role="list" aria-label="Attached images" className="flex flex-wrap gap-1.5">
      {images.map((file, index) => (
        <div
          key={`${file.name}:${index}`}
          role="listitem"
          className="flex h-9 min-w-0 max-w-56 items-center gap-2 rounded-md border border-border bg-surface-2/50 pl-1 pr-1.5 text-xs text-fg-muted"
        >
          <img
            src={urls[index]}
            alt={file.name}
            title={file.name}
            className="size-7 shrink-0 rounded-md object-cover"
          />
          {/* The image already carries the name for assistive tech. */}
          <span aria-hidden className="min-w-0 truncate">
            {file.name}
          </span>
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove?.(index)}
            className={rowAction}
          >
            <X size={12} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}

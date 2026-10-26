import { Download, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'

/** Full-size preview of one transcript image, with a download link; closed while `image` is null. */
export function ImagePreviewDialog({
  image,
  onClose,
}: {
  image: { name: string; url: string } | null
  onClose: () => void
}) {
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content size="lg" className="overflow-hidden bg-surface-0">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
          <div className="min-w-0 flex-1">
            <Dialog.Title className="truncate text-sm">{image?.name ?? 'Image'}</Dialog.Title>
            <Dialog.Description className="sr-only">Full-size image preview</Dialog.Description>
          </div>
          {image !== null ? (
            <a
              href={image.url}
              download={image.name}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-xs font-medium text-fg transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <Download size={13} aria-hidden="true" />
              Download
            </a>
          ) : null}
          <Dialog.Close
            aria-label="Close image preview"
            className="flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={15} aria-hidden="true" />
          </Dialog.Close>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-0 p-4">
          {image !== null ? (
            <img
              src={image.url}
              alt={`Full-size ${image.name}`}
              className="max-h-full max-w-full object-contain shadow-2"
            />
          ) : null}
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

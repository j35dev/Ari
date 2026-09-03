import { rpc } from '../../lib/rpc'

/**
 * Data URLs for staged attachments, fetched once per id and shared by every
 * thumbnail of that image. Entries resolve to null when the staged file is
 * gone; callers render the filename instead of a broken image.
 */
const cache = new Map<string, Promise<string | null>>()

export function attachmentDataUrl(id: string): Promise<string | null> {
  const cached = cache.get(id)
  if (cached) return cached
  const pending = rpc
    .invoke('attachments.read', { id })
    .then((result) =>
      result.attachment === null
        ? null
        : `data:${result.attachment.mimeType};base64,${result.attachment.dataBase64}`,
    )
    .catch(() => null)
  cache.set(id, pending)
  return pending
}

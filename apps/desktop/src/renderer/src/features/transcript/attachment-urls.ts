import { createSessionClient, type SessionClient } from '../session/session-client'
import { parseSessionViewKey, registerSessionCacheInvalidator } from '../session/session-scope'

/**
 * Data URLs for staged attachments, fetched once per id and shared by every
 * thumbnail of that image. Entries resolve to null when the staged file is
 * gone; callers render the filename instead of a broken image.
 */
const cache = new Map<string, Promise<string | null>>()

const localClient = createSessionClient({ kind: 'local', sessionId: '' })
registerSessionCacheInvalidator((machineId) => {
  for (const key of cache.keys()) {
    const [viewKey] = JSON.parse(key) as [string]
    const scope = parseSessionViewKey(viewKey)
    if (scope?.kind === 'remote' && scope.machineId === machineId) cache.delete(key)
  }
})
export function refreshAttachmentUrls(client: SessionClient): void {
  for (const key of cache.keys()) if ((JSON.parse(key) as [string])[0] === client.viewKey) cache.delete(key)
}
export function attachmentDataUrl(id: string, client = localClient): Promise<string | null> {
  const epoch = client.authorizationEpoch
  const key = JSON.stringify([client.viewKey, epoch, id])
  const cached = cache.get(key)
  if (cached) return cached
  const pending = client
    .invoke('attachments.read', { id })
    .then((result) =>
      epoch !== client.authorizationEpoch || result.attachment === null
        ? null
        : `data:${result.attachment.mimeType};base64,${result.attachment.dataBase64}`,
    )
    .catch(() => { cache.delete(key); return null })
  cache.set(key, pending)
  return pending
}

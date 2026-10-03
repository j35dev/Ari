import {
  remoteIntegrationPreviewSchema,
  idempotencyKeySchema,
  type RemoteIntegrationPreview,
} from '@ari/contracts/remote'
export interface ReviewedIntegration {
  preview: RemoteIntegrationPreview
  key: string
}

/** Restore an uncertain integration using the exact reviewed parent and child snapshots. */
export function readIntegration(
  origin: string | null,
  deviceId: string | null,
  sessionId: string,
): ReviewedIntegration | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(origin, deviceId, sessionId)) ?? 'null',
    )
    if (typeof value !== 'object' || value === null || !('preview' in value) || !('key' in value))
      return null
    const preview = remoteIntegrationPreviewSchema.safeParse(value.preview)
    const key = idempotencyKeySchema.safeParse(value.key)
    return preview.success && key.success && preview.data.sessionId === sessionId
      ? { preview: preview.data, key: key.data }
      : null
  } catch (error) {
    console.warn('Could not restore the integration receipt', error)
    return null
  }
}

/** Retain an integration receipt until the computer confirms its outcome or a definite refusal. */
export function writeIntegration(
  origin: string | null,
  deviceId: string | null,
  sessionId: string,
  reviewed: ReviewedIntegration | null,
): boolean {
  try {
    const key = storageKey(origin, deviceId, sessionId)
    if (reviewed === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(reviewed))
    return true
  } catch (error) {
    console.warn('Could not save the integration receipt', error)
    return false
  }
}
function storageKey(origin: string | null, deviceId: string | null, sessionId: string): string {
  return `ari.integration:${origin ?? ''}:${deviceId ?? ''}:${sessionId}`
}

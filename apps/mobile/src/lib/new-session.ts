import { remoteCommandEnvelopeSchema } from '@ari/contracts/remote'
export interface NewSessionRequest {
  key: string
  projectId: string
  driverKind: string
  modelId: string
  draft: string
}

/** Recover the single unconfirmed creation for this computer and phone. */
export function readCreation(
  origin: string | null,
  deviceId: string | null,
): NewSessionRequest | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(origin, deviceId)) ?? 'null',
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !('command' in value) ||
      !('draft' in value) ||
      typeof value.draft !== 'string'
    )
      return null
    const parsed = remoteCommandEnvelopeSchema.safeParse(value.command)
    if (!parsed.success || parsed.data.op !== 'session.create') return null
    return {
      key: parsed.data.idempotencyKey,
      projectId: parsed.data.projectId,
      driverKind: parsed.data.driverKind ?? '',
      modelId: parsed.data.modelId ?? '',
      draft: value.draft,
    }
  } catch (error) {
    console.warn('Could not restore the session creation', error)
    return null
  }
}

/** Preserve creation before sending so dismissing the sheet cannot duplicate a session. */
export function writeCreation(
  origin: string | null,
  deviceId: string | null,
  request: NewSessionRequest | null,
): boolean {
  try {
    const key = storageKey(origin, deviceId)
    if (request === null) sessionStorage.removeItem(key)
    else
      sessionStorage.setItem(
        key,
        JSON.stringify({
          command: {
            op: 'session.create',
            projectId: request.projectId,
            ...(request.driverKind ? { driverKind: request.driverKind } : {}),
            ...(request.modelId ? { modelId: request.modelId } : {}),
            clientCommandId: request.key,
            idempotencyKey: request.key,
          },
          draft: request.draft,
        }),
      )
    return true
  } catch (error) {
    console.warn('Could not save the session creation receipt', error)
    return false
  }
}
function storageKey(origin: string | null, deviceId: string | null): string {
  return `ari.creation:${origin ?? ''}:${deviceId ?? ''}`
}

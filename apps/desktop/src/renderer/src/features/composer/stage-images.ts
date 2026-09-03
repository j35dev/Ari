import type { AttachmentRef } from '@ari/contracts/attachments'
import { rpc } from '../../lib/rpc'

/** Encodes bytes as base64 without blowing the stack on multi-MB images. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Stages composer image files in the main process and returns the refs the
 * turn commands carry. Throws with the staging failure reason; callers toast
 * and keep the message unsent rather than silently dropping the images.
 */
export async function stageImages(files: File[]): Promise<AttachmentRef[]> {
  const encoded = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      dataBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    })),
  )
  const result = await rpc.invoke('attachments.stage', { files: encoded })
  return result.attachments
}

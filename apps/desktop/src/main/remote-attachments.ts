import { MAX_REMOTE_IMAGE_BYTES, type RemoteCommand } from '@ari/contracts/remote'
import type { AttachmentRef } from '@ari/contracts/attachments'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import type { SessionReadModel } from '@ari/engine/projection'
import type { AttachmentStore } from './attachments'

const TTL_MS = 10 * 60 * 1000
const MAX_STAGED_PER_DEVICE = 16

function matchesImage(bytes: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'image/jpeg':
      return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      )
    default:
      return false
  }
}

/** Session/device-scoped staging grants; existing image access is derived from the authorized journal. */
export class RemoteAttachments {
  readonly #store: Pick<AttachmentStore, 'stage' | 'read'>
  readonly #staged = new Map<
    string,
    { deviceId: string; sessionId: string; ref: AttachmentRef; expiresAt: number }
  >()

  constructor(store: Pick<AttachmentStore, 'stage' | 'read'>) {
    this.#store = store
  }

  #prune(): void {
    for (const [id, grant] of this.#staged)
      if (grant.expiresAt <= Date.now()) this.#staged.delete(id)
  }

  #reference(
    caller: RemoteCaller,
    sessionId: string,
    id: string,
    model: SessionReadModel,
  ): AttachmentRef | undefined {
    this.#prune()
    const staged = this.#staged.get(id)
    if (staged?.deviceId === caller.deviceId && staged.sessionId === sessionId) return staged.ref
    for (const message of model.messages) {
      const image = message.parts.find((part) => part.type === 'image' && part.attachmentId === id)
      if (image?.type === 'image')
        return { id, name: image.name, mimeType: image.mimeType, size: image.size }
    }
    return model.queuedMessages
      .flatMap((message) => message.attachments)
      .find((ref) => ref.id === id)
  }

  async stage(
    caller: RemoteCaller,
    command: Extract<RemoteCommand, { op: 'attachments.stage' }>,
  ): Promise<AttachmentRef[] | null> {
    this.#prune()
    if (
      [...this.#staged.values()].filter((grant) => grant.deviceId === caller.deviceId).length +
        command.files.length >
        MAX_STAGED_PER_DEVICE ||
      this.#staged.size + command.files.length > 256
    )
      return null
    for (const file of command.files) {
      const bytes = Buffer.from(file.dataBase64, 'base64')
      if (
        bytes.length === 0 ||
        bytes.length > MAX_REMOTE_IMAGE_BYTES ||
        !matchesImage(bytes, file.mimeType)
      )
        return null
    }
    const refs = await this.#store.stage(command.files)
    for (const ref of refs)
      this.#staged.set(ref.id, {
        deviceId: caller.deviceId,
        sessionId: command.sessionId,
        ref,
        expiresAt: Date.now() + TTL_MS,
      })
    return refs
  }

  resolve(
    caller: RemoteCaller,
    sessionId: string,
    ids: string[],
    model: SessionReadModel,
  ): AttachmentRef[] | null {
    const refs = ids.map((id) => this.#reference(caller, sessionId, id, model))
    if (refs.some((ref) => ref === undefined) || new Set(ids).size !== ids.length) return null
    return refs as AttachmentRef[]
  }

  async read(
    caller: RemoteCaller,
    sessionId: string,
    id: string,
    model: SessionReadModel,
  ): Promise<{
    name: string
    mimeType: string
    size: number
    dataBase64: string
  } | null> {
    const ref = this.#reference(caller, sessionId, id, model)
    if (ref === undefined || ref.size > MAX_REMOTE_IMAGE_BYTES) return null
    const image = await this.#store.read(id)
    if (
      image === null ||
      image.size > MAX_REMOTE_IMAGE_BYTES ||
      !matchesImage(Buffer.from(image.dataBase64, 'base64'), image.mimeType)
    )
      return null
    return image
  }
}

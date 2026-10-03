import { remoteCommandEnvelopeSchema, type RemoteCommand } from '@ari/contracts/remote'

type ForkCommand = Extract<RemoteCommand, { op: 'session.fork' }>
export type ForkRequest = Pick<ForkCommand, 'title' | 'driverKind' | 'modelId'> & { key: string }

/** Retain a fork receipt in this tab, scoped to its computer, paired device, and parent. */
export class ForkRequestStore {
  readonly #key: string | null
  readonly #parentId: string

  constructor(origin: string | null, deviceId: string | null, parentId: string) {
    this.#key =
      origin === null || deviceId === null
        ? null
        : `ari.fork:${JSON.stringify([origin, deviceId, parentId])}`
    this.#parentId = parentId
  }

  read(): ForkRequest | null {
    if (this.#key === null) return null
    try {
      const raw = sessionStorage.getItem(this.#key)
      if (raw === null) return null
      const parsed = remoteCommandEnvelopeSchema.safeParse(JSON.parse(raw) as unknown)
      if (
        !parsed.success ||
        parsed.data.op !== 'session.fork' ||
        parsed.data.sessionId !== this.#parentId ||
        parsed.data.clientCommandId !== parsed.data.idempotencyKey
      )
        return null
      const command = parsed.data
      return {
        key: command.idempotencyKey,
        title: command.title,
        ...(command.driverKind === undefined ? {} : { driverKind: command.driverKind }),
        ...(command.modelId === undefined ? {} : { modelId: command.modelId }),
      }
    } catch (error) {
      console.warn('Could not restore the fork request', error)
      return null
    }
  }

  write(request: ForkRequest): void {
    if (this.#key === null) throw new Error('Reconnect this paired phone before forking.')
    const { key, ...fields } = request
    const command = remoteCommandEnvelopeSchema.parse({
      ...fields,
      op: 'session.fork',
      sessionId: this.#parentId,
      clientCommandId: key,
      idempotencyKey: key,
    })
    try {
      sessionStorage.setItem(this.#key, JSON.stringify(command))
    } catch (error) {
      console.warn('Could not preserve the fork receipt', error)
      throw new Error(
        'This phone could not save the fork receipt. Enable browser storage before creating it.',
        { cause: error },
      )
    }
  }

  clear(): void {
    if (this.#key === null) return
    try {
      sessionStorage.removeItem(this.#key)
    } catch (error) {
      console.warn('Could not clear the completed fork receipt', error)
    }
  }
}

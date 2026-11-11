import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  machineIdentitySchema,
  machineRouteSchema,
  type MachineIdentity,
  type MachineRoute,
} from '@ari/contracts/machines'
import { pairingKeySchema, type PairingPublicKey } from '@ari/contracts/remote'
import type { DeviceCredential } from '@ari/remote-client'
import type { SecretBox } from '@ari/ari-core/endpoints'

const recordSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(100),
    routes: z.array(machineRouteSchema).min(1).max(8),
    identity: machineIdentitySchema.nullable(),
    lastSeenAt: z.number().nullable(),
    credentialCipher: z.string().min(1).max(16384).nullable(),
  })
  .strict()
const registrySchema = z
  .object({ version: z.literal(1), machines: z.array(recordSchema).max(100) })
  .strict()
export type MachineRecord = z.infer<typeof recordSchema>

/** Only ciphertext reaches disk. Corrupt records fail closed rather than being replaced. */
export class MachinesRegistry {
  readonly #path: string
  #records: MachineRecord[]

  constructor(path: string) {
    this.#path = path
    if (!existsSync(path)) this.#records = []
    else {
      if (statSync(path).size > 2 * 1024 * 1024)
        throw new Error('The saved machines registry is too large.')
      this.#records = registrySchema.parse(JSON.parse(readFileSync(path, 'utf8'))).machines
      if (new Set(this.#records.map((row) => row.id)).size !== this.#records.length)
        throw new Error('The saved machines registry contains duplicate identifiers.')
    }
  }

  list(): MachineRecord[] {
    return structuredClone(this.#records)
  }
  get(id: string): MachineRecord {
    const record = this.#records.find((row) => row.id === id)
    if (record === undefined) throw new Error('This computer is no longer saved.')
    return structuredClone(record)
  }
  add(name: string, route: MachineRoute, identity: MachineIdentity | null): MachineRecord {
    const duplicate = this.#records.find((row) =>
      row.routes.some((item) => item.origin === route.origin),
    )
    if (duplicate !== undefined) return this.get(duplicate.id)
    // Public machine identity can be copied. A new origin must be paired
    // independently; it never inherits another origin's approved device key.
    if (this.#records.length >= 100)
      throw new Error('Remove a saved computer before adding another.')
    // The local id scopes drafts and receipts; host identity is checked separately on reconnect.
    const record: MachineRecord = {
      id: `machine_${randomUUID()}`,
      name,
      routes: [route],
      identity,
      lastSeenAt: identity === null ? null : Date.now(),
      credentialCipher: null,
    }
    this.#save([...this.#records, record])
    return this.get(record.id)
  }
  update(
    id: string,
    patch: Partial<Pick<MachineRecord, 'name' | 'identity' | 'lastSeenAt' | 'credentialCipher'>>,
  ): MachineRecord {
    const record = recordSchema.parse({ ...this.get(id), ...patch })
    this.#save(this.#records.map((row) => (row.id === id ? record : row)))
    return this.get(id)
  }
  remove(id: string): boolean {
    if (!this.#records.some((row) => row.id === id)) return false
    this.#save(this.#records.filter((row) => row.id !== id))
    return true
  }
  #save(records: MachineRecord[]): void {
    const data = registrySchema.parse({ version: 1, machines: records })
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.#path)
    this.#records = data.machines
  }
}

const credentialSchema = z
  .object({
    machineId: z.string(),
    privateKeyPem: z.string().min(1).max(8192),
    deviceId: z.string().nullable(),
    displayName: z.string().nullable(),
  })
  .strict()

/** Main-process P-256 credential. There is intentionally no plaintext-file fallback. */
export class DesktopMachineCredential implements DeviceCredential {
  readonly #id: string
  readonly #registry: MachinesRegistry
  readonly #secretBox: () => SecretBox | null
  #privateKey: KeyObject | null = null
  #deviceId: string | null = null
  #displayName: string | null = null
  #loaded = false

  constructor(id: string, registry: MachinesRegistry, secretBox: () => SecretBox | null) {
    this.#id = id
    this.#registry = registry
    this.#secretBox = secretBox
  }
  get deviceId(): string | null {
    return this.#deviceId
  }
  load(): Promise<void> {
    return Promise.resolve().then(() => this.#load())
  }
  #load(): void {
    if (this.#loaded) return
    const cipher = this.#registry.get(this.#id).credentialCipher
    if (cipher !== null) {
      const plain = this.#box().decrypt(cipher)
      if (plain === null)
        throw new Error('This computer credential cannot be unlocked. Remove it and pair again.')
      const stored = credentialSchema.parse(JSON.parse(plain))
      if (stored.machineId !== this.#id)
        throw new Error('This computer credential belongs to another computer.')
      const key = createPrivateKey(stored.privateKeyPem)
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        throw new Error('The saved computer credential is invalid.')
      this.#privateKey = key
      this.#deviceId = stored.deviceId
      this.#displayName = stored.displayName
    }
    this.#loaded = true
  }
  async publicKey(): Promise<PairingPublicKey> {
    await this.load()
    if (this.#privateKey === null) {
      this.#box()
      this.#privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
      this.#persist()
    }
    return pairingKeySchema.parse(createPublicKey(this.#privateKey).export({ format: 'jwk' }))
  }
  async sign(nonce: string): Promise<string> {
    await this.load()
    if (this.#privateKey === null) throw new Error('Pair this computer before signing a challenge.')
    return sign('sha256', Buffer.from(nonce), {
      key: this.#privateKey,
      dsaEncoding: 'der',
    }).toString('base64')
  }
  remember(record: { deviceId: string; displayName: string; projectIds: string[] }): Promise<void> {
    return Promise.resolve().then(() => {
      this.#deviceId = record.deviceId
      this.#displayName = record.displayName
      this.#persist()
    })
  }
  #box(): SecretBox {
    const box = this.#secretBox()
    if (box === null)
      throw new Error(
        'Secure storage is unavailable. Enable the operating system keyring before pairing a computer.',
      )
    return box
  }
  #persist(): void {
    if (this.#privateKey === null) throw new Error('The computer credential has no key.')
    const plain = JSON.stringify({
      machineId: this.#id,
      privateKeyPem: this.#privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      deviceId: this.#deviceId,
      displayName: this.#displayName,
    })
    this.#registry.update(this.#id, { credentialCipher: this.#box().encrypt(plain) })
  }
}

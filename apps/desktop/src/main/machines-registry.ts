import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  machineIdentitySchema,
  machineRouteSchema,
  type MachineIdentity,
  type MachineRoute,
  machinesPreferencesSchema,
  machineAutoPreferenceSchema,
  LOCAL_MACHINE_PREFERENCE_ID,
  type MachineAutoPreference,
  type MachinesPreferences,
} from '@ari/contracts/machines'
import { signedHostRouteManifestSchema, type SignedHostRouteManifest } from '@ari/contracts/route-auth'
import { pairingKeySchema, type PairingPublicKey } from '@ari/contracts/remote'
import type { DeviceCredential } from '@ari/remote-client'
import type { SecretBox } from '@ari/ari-core/endpoints'

const recordSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(100),
    routes: z.array(machineRouteSchema).min(1).max(16),
    identity: machineIdentitySchema.nullable(),
    lastSeenAt: z.number().nullable(),
    credentialCipher: z.string().min(1).max(16384).nullable(),
    credentialOrigin: z.string().url().max(2048),
    hostKey: z.object({ hostId: z.string().min(1).max(200), publicKey: pairingKeySchema }).strict().nullable(),
    manifest: signedHostRouteManifestSchema.nullable(),
  })
  .strict()
const registrySchema = z
  .object({ version: z.literal(2), machines: z.array(recordSchema).max(100), preferences: machinesPreferencesSchema })
  .strict()
const legacyRegistrySchema = z.object({ version: z.literal(1), machines: z.array(recordSchema.omit({credentialOrigin: true, hostKey: true, manifest: true})).max(100) }).strict()
const defaultPreferences = (): MachinesPreferences => ({ autoEnabled: false, hostTiers: {}, projectHosts: {} })
export type MachineRecord = z.infer<typeof recordSchema>

/** Only ciphertext reaches disk. Corrupt records fail closed rather than being replaced. */
export class MachinesRegistry {
  readonly #path: string
  #records: MachineRecord[]
  #preferences: MachinesPreferences = defaultPreferences()

  constructor(path: string) {
    this.#path = path
    if (!existsSync(path)) this.#records = []
    else {
      if (statSync(path).size > 2 * 1024 * 1024)
        throw new Error('The saved machines registry is too large.')
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const legacy = legacyRegistrySchema.safeParse(raw)
      if (legacy.success) {
        this.#records = legacy.data.machines.map((record) => ({ ...record,
          routes: record.routes.map((route) => ({...route, source: 'manual' as const})),
          credentialOrigin: record.routes[0]!.origin, hostKey: null, manifest: null }))
      } else {
        const data = registrySchema.parse(raw)
        this.#records = data.machines
        this.#preferences = data.preferences
      }
      if (new Set(this.#records.map((row) => row.id)).size !== this.#records.length)
        throw new Error('The saved machines registry contains duplicate identifiers.')
      for (const row of this.#records) this.#validateRoutes(row)
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
      routes: [{...route, source: 'manual'}],
      identity,
      lastSeenAt: identity === null ? null : Date.now(),
      credentialCipher: null,
      credentialOrigin: route.origin,
      hostKey: null,
      manifest: null,
    }
    this.#save([...this.#records, record])
    return this.get(record.id)
  }
  update(
    id: string,
    patch: Partial<Pick<MachineRecord, 'name' | 'identity' | 'lastSeenAt' | 'credentialCipher' | 'routes' | 'hostKey' | 'manifest'>>,
  ): MachineRecord {
    const record = recordSchema.parse({ ...this.get(id), ...patch })
    this.#validateRoutes(record)
    this.#save(this.#records.map((row) => (row.id === id ? record : row)))
    return this.get(id)
  }
  remove(id: string): boolean {
    if (!this.#records.some((row) => row.id === id)) return false
    const preferences = this.preferences()
    delete preferences.hostTiers[id]
    for (const [key, host] of Object.entries(preferences.projectHosts)) if (host === id) delete preferences.projectHosts[key]
    this.#save(this.#records.filter((row) => row.id !== id), preferences)
    return true
  }
  preferences(): MachinesPreferences { return structuredClone(this.#preferences) }
  setAuto(enabled: boolean): MachinesPreferences {
    this.#save(this.#records, {...this.preferences(), autoEnabled: enabled})
    return this.preferences()
  }
  setPreference(id: string, tier: MachineAutoPreference): MachinesPreferences {
    if (id !== LOCAL_MACHINE_PREFERENCE_ID) this.get(id)
    const preferences = this.preferences()
    preferences.hostTiers[id] = machineAutoPreferenceSchema.parse(tier)
    this.#save(this.#records, preferences)
    return this.preferences()
  }
  rememberProjectHost(projectKey: string, id: string): MachinesPreferences {
    if (id !== LOCAL_MACHINE_PREFERENCE_ID) this.get(id)
    const preferences = this.preferences()
    preferences.projectHosts[projectKey] = id
    this.#save(this.#records, preferences)
    return this.preferences()
  }
  learn(id: string, manifest: SignedHostRouteManifest, routes: MachineRoute[]): MachineRecord {
    const row = this.get(id)
    const reported = new Set(routes.map((route) => route.origin))
    const next = row.routes.filter((route) => route.source !== 'learned' || reported.has(route.origin))
    for (const route of routes) if (!next.some((item) => item.origin === route.origin))
      next.push({...route, source: 'learned', credentialOrigin: row.credentialOrigin})
    return this.update(id, { routes: next.slice(0, 16), manifest,
      hostKey: {hostId: manifest.payload.hostId, publicKey: manifest.payload.publicKey} })
  }
  #validateRoutes(row: MachineRecord): void {
    if (new Set(row.routes.map((route) => route.origin)).size !== row.routes.length ||
      !row.routes.some((route) => route.origin === row.credentialOrigin && route.source !== 'learned') ||
      row.routes.some((route) => route.credentialOrigin !== undefined && route.credentialOrigin !== row.credentialOrigin) ||
      (row.hostKey !== null && row.identity?.machineId !== undefined && row.hostKey.hostId !== row.identity.machineId))
      throw new Error('The saved computer routes have invalid credential bindings.')
    if (row.manifest !== null && (row.hostKey === null || row.hostKey.hostId !== row.manifest.payload.hostId ||
      row.hostKey.publicKey.x !== row.manifest.payload.publicKey.x || row.hostKey.publicKey.y !== row.manifest.payload.publicKey.y))
      throw new Error('The saved computer route manifest does not match its pinned identity.')
  }
  #save(records: MachineRecord[], preferences = this.#preferences): void {
    const data = registrySchema.parse({ version: 2, machines: records, preferences })
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd) } finally { closeSync(fd) }
    try { renameSync(temporary, this.#path) } catch (error) { unlinkSync(temporary); throw error }
    this.#records = data.machines
    this.#preferences = data.preferences
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
      const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
      // A failed seal/write must not leave an unpersisted key usable in memory.
      this.#persist(key, this.#deviceId, this.#displayName)
      this.#privateKey = key
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
      if (this.#privateKey === null) throw new Error('The computer credential has no key.')
      this.#persist(this.#privateKey, record.deviceId, record.displayName)
      this.#deviceId = record.deviceId
      this.#displayName = record.displayName
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
  #persist(privateKey: KeyObject, deviceId: string | null, displayName: string | null): void {
    const plain = JSON.stringify({
      machineId: this.#id,
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      deviceId,
      displayName,
    })
    this.#registry.update(this.#id, { credentialCipher: this.#box().encrypt(plain) })
  }
}

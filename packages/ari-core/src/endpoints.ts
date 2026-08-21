import { z } from 'zod'

/** A user-configured model endpoint for the Ari Core built-in harness. */
export const endpointSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  flavor: z.enum(['openai-chat', 'anthropic-messages', 'ollama']),
  model: z.string().min(1),
  /** Encrypted at rest by the desktop layer; never logged. */
  apiKeyCipher: z.string().nullable(),
  headers: z.record(z.string(), z.string()).default({}),
})
export type Endpoint = z.infer<typeof endpointSchema>

/**
 * Secret box abstraction: the desktop layer plugs Electron safeStorage in;
 * tests plug a passthrough. Ari Core itself never sees plaintext keys on
 * disk.
 */
export interface SecretBox {
  encrypt(plaintext: string): string
  decrypt(cipher: string): string | null
}

export const passthroughSecretBox: SecretBox = {
  encrypt: (p) => p,
  decrypt: (c) => c,
}

export interface EndpointStoreOptions {
  /** Directory holding endpoints.json (typically <userData>/ari-core). */
  dir: string
  secretBox?: SecretBox
}

/**
 * CRUD store for model endpoints with atomic writes. API keys are stored
 * encrypted via the injected {@link SecretBox} and are redacted from list
 * output.
 */
export class EndpointStore {
  readonly #dir: string
  readonly #box: SecretBox
  #endpoints: Endpoint[] = []

  constructor(options: EndpointStoreOptions) {
    this.#dir = options.dir
    this.#box = options.secretBox ?? passthroughSecretBox
  }

  async load(): Promise<Endpoint[]> {
    const { readFile } = await import('node:fs/promises')
    try {
      const raw = await readFile(`${this.#dir}/endpoints.json`, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.#endpoints = z.array(endpointSchema).parse(parsed)
    } catch {
      this.#endpoints = []
    }
    return this.list()
  }

  /** Endpoints with key material redacted — safe for IPC/UI. */
  list(): Endpoint[] {
    return this.#endpoints.map((e) => ({ ...e, apiKeyCipher: e.apiKeyCipher ? '••••' : null }))
  }

  async upsert(
    input: Omit<Endpoint, 'apiKeyCipher'> & {
      apiKey?: string | null
      apiKeyCipher?: string | null
    },
  ): Promise<Endpoint> {
    const { mkdir, writeFile, rename } = await import('node:fs/promises')
    await mkdir(this.#dir, { recursive: true })
    const cipher = input.apiKey ? this.#box.encrypt(input.apiKey) : null
    const endpoint: Endpoint = {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      flavor: input.flavor,
      model: input.model,
      headers: input.headers,
      apiKeyCipher:
        input.apiKey != null
          ? (cipher ?? null)
          : input.apiKey === null
            ? null
            : (input.apiKeyCipher ?? null),
    }
    const validated = endpointSchema.parse(endpoint)
    this.#endpoints = [...this.#endpoints.filter((e) => e.id !== validated.id), validated]
    await writeFile(
      `${this.#dir}/endpoints.json.tmp`,
      JSON.stringify(this.#endpoints, null, 2),
      'utf8',
    )
    await rename(`${this.#dir}/endpoints.json.tmp`, `${this.#dir}/endpoints.json`)
    return { ...validated, apiKeyCipher: validated.apiKeyCipher ? '••••' : null }
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#endpoints.length
    this.#endpoints = this.#endpoints.filter((e) => e.id !== id)
    if (this.#endpoints.length === before) return false
    const { mkdir, writeFile, rename } = await import('node:fs/promises')
    await mkdir(this.#dir, { recursive: true })
    await writeFile(
      `${this.#dir}/endpoints.json.tmp`,
      JSON.stringify(this.#endpoints, null, 2),
      'utf8',
    )
    await rename(`${this.#dir}/endpoints.json.tmp`, `${this.#dir}/endpoints.json`)
    return true
  }

  /** Decrypts the key for one endpoint; only the protocol clients call this. */
  apiKeyFor(id: string): string | null {
    const e = this.#endpoints.find((x) => x.id === id)
    if (!e?.apiKeyCipher || e.apiKeyCipher === '••••') return null
    return this.#box.decrypt(e.apiKeyCipher)
  }
}

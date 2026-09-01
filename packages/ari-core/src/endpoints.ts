import { z } from 'zod'
import { endpointFlavorSchema, endpointModelSchema } from '@ari/contracts/endpoint'
import type { EndpointFlavor, EndpointModel } from '@ari/contracts/endpoint'

export { endpointFlavorSchema, endpointModelSchema }
export type { EndpointFlavor, EndpointModel }

/** A user-configured model endpoint for the Ari Core built-in harness. */
export const endpointSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  flavor: endpointFlavorSchema,
  /** Default model used when a session does not name one explicitly. */
  model: z.string().min(1),
  /**
   * Every model available on this endpoint. Older config files predate the
   * field; {@link EndpointStore.load} backfills them from `model`.
   */
  models: z.array(endpointModelSchema).default([]),
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
 * output. Each endpoint carries a model list; the default `model` is always
 * present in it, so a config written before multi-model support still yields
 * one selectable model.
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
      this.#endpoints = z.array(endpointSchema).parse(parsed).map(withDefaultModel)
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
    input: Omit<Endpoint, 'apiKeyCipher' | 'models'> & {
      models?: EndpointModel[]
      apiKey?: string | null
      apiKeyCipher?: string | null
    },
  ): Promise<Endpoint> {
    const cipher = input.apiKey ? this.#box.encrypt(input.apiKey) : null
    const existing = this.#endpoints.find((e) => e.id === input.id)
    const endpoint: Endpoint = {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      flavor: input.flavor,
      model: input.model,
      // Omitted models keep the stored list; an explicit list replaces it.
      models: input.models ?? existing?.models ?? [],
      headers: input.headers,
      // A new key wins; explicit null clears; omission keeps the stored one.
      apiKeyCipher:
        input.apiKey != null
          ? (cipher ?? null)
          : input.apiKey === null
            ? null
            : (input.apiKeyCipher ?? existing?.apiKeyCipher ?? null),
    }
    const validated = withDefaultModel(endpointSchema.parse(endpoint))
    this.#endpoints = [...this.#endpoints.filter((e) => e.id !== validated.id), validated]
    await this.#persist()
    return { ...validated, apiKeyCipher: validated.apiKeyCipher ? '••••' : null }
  }

  /**
   * Replaces an endpoint's model list, keeping manually-added entries that
   * discovery did not return. When the endpoint's default model disappears
   * from the merged list, the first available model takes over so the
   * endpoint is never left pointing at a model it cannot serve.
   */
  async setModels(id: string, models: EndpointModel[]): Promise<Endpoint | null> {
    const existing = this.#endpoints.find((e) => e.id === id)
    if (!existing) return null
    const parsed = z.array(endpointModelSchema).parse(models)
    const byId = new Map(parsed.map((m) => [m.id, m]))
    for (const kept of existing.models) {
      // Hand-added models survive a discovery refresh that omits them.
      if (kept.source === 'manual' && !byId.has(kept.id)) byId.set(kept.id, kept)
    }
    const merged = [...byId.values()]
    const model = byId.has(existing.model) ? existing.model : (merged[0]?.id ?? existing.model)
    const next = withDefaultModel({ ...existing, models: merged, model })
    this.#endpoints = this.#endpoints.map((e) => (e.id === id ? next : e))
    await this.#persist()
    return { ...next, apiKeyCipher: next.apiKeyCipher ? '••••' : null }
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#endpoints.length
    this.#endpoints = this.#endpoints.filter((e) => e.id !== id)
    if (this.#endpoints.length === before) return false
    await this.#persist()
    return true
  }

  /** Decrypts the key for one endpoint; only the protocol clients call this. */
  apiKeyFor(id: string): string | null {
    const e = this.#endpoints.find((x) => x.id === id)
    if (!e?.apiKeyCipher || e.apiKeyCipher === '••••') return null
    return this.#box.decrypt(e.apiKeyCipher)
  }

  async #persist(): Promise<void> {
    const { mkdir, writeFile, rename } = await import('node:fs/promises')
    await mkdir(this.#dir, { recursive: true })
    await writeFile(
      `${this.#dir}/endpoints.json.tmp`,
      JSON.stringify(this.#endpoints, null, 2),
      'utf8',
    )
    await rename(`${this.#dir}/endpoints.json.tmp`, `${this.#dir}/endpoints.json`)
  }
}

/**
 * Guarantees the default `model` appears in `models`, so configs written
 * before multi-model support still expose one selectable entry.
 */
function withDefaultModel(endpoint: Endpoint): Endpoint {
  if (endpoint.models.some((m) => m.id === endpoint.model)) return endpoint
  return {
    ...endpoint,
    models: [
      { id: endpoint.model, label: endpoint.model, contextWindow: null, source: 'manual' },
      ...endpoint.models,
    ],
  }
}

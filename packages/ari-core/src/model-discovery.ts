import type { DiscoveredModel, EndpointFlavor } from '@ari/contracts/endpoint'

/**
 * Model discovery for user-configured endpoints. Every supported flavor
 * exposes a list endpoint whose metadata we normalize into one shape:
 *
 * - `openai-chat`      → `GET {baseUrl}/models` (OpenAI `/v1/models`)
 * - `anthropic-messages` → `GET {baseUrl}/models` (Anthropic models API)
 * - `ollama`           → `GET {baseUrl}/api/tags`
 *
 * Discovery is best-effort: a server that does not implement listing simply
 * yields no models, and the user adds them by hand instead.
 */

export type { DiscoveredModel }

export type DiscoveryFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>

export interface DiscoverModelsRequest {
  baseUrl: string
  flavor: EndpointFlavor
  apiKey: string | null
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface DiscoverModelsResult {
  models: DiscoveredModel[]
  /** Null on success; a short human-readable reason otherwise. */
  error: string | null
}

const DEFAULT_TIMEOUT_MS = 8000

const defaultDiscoveryFetch: DiscoveryFetch = async (url, init) => {
  const response = await fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json: () => response.json() as Promise<unknown>,
  }
}

/** Path appended to the endpoint base URL for each flavor's model listing. */
export function modelsPathFor(flavor: EndpointFlavor): string {
  return flavor === 'ollama' ? '/api/tags' : '/models'
}

function authHeaders(
  flavor: EndpointFlavor,
  apiKey: string | null,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...extra }
  if (flavor === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
    return headers
  }
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  return headers
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return null
}

/** Rows carrying the model list, across the shapes servers actually return. */
function rowsFrom(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
  }
  const record = asRecord(payload)
  if (record === null) return []
  for (const key of ['data', 'models', 'result']) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    }
  }
  return []
}

/**
 * Normalizes one model row. OpenAI-compatible servers use `id` plus optional
 * `context_length`/`context_window` (LM Studio, vLLM, OpenRouter all differ);
 * Ollama's `/api/tags` uses `name` plus a nested `details.family`.
 */
function normalizeRow(row: Record<string, unknown>): DiscoveredModel | null {
  const id = stringField(row, 'id', 'name', 'model')
  if (id === null) return null
  const details = asRecord(row['details'])
  const nestedContext = asRecord(row['top_provider'])
  return {
    id,
    label: stringField(row, 'display_name', 'displayName', 'name') ?? id,
    contextWindow:
      numberField(row, 'context_length', 'context_window', 'contextWindow', 'max_context_length') ??
      (nestedContext !== null ? numberField(nestedContext, 'context_length') : null),
    owner:
      stringField(row, 'owned_by', 'ownedBy', 'organization') ??
      (details !== null ? stringField(details, 'family', 'parent_model') : null),
  }
}

/**
 * Fetches and normalizes the model list an endpoint advertises. Never throws:
 * transport and parse failures come back as `{ models: [], error }` so the UI
 * can show the reason and fall back to manual entry.
 */
export async function discoverModels(
  request: DiscoverModelsRequest,
  discoveryFetch: DiscoveryFetch = defaultDiscoveryFetch,
): Promise<DiscoverModelsResult> {
  const base = request.baseUrl.replace(/\/+$/, '')
  const url = `${base}${modelsPathFor(request.flavor)}`
  const headers = authHeaders(request.flavor, request.apiKey, request.headers)
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let response
  try {
    response = await discoveryFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return { models: [], error: timedOut ? 'timed out' : 'endpoint unreachable' }
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? 'check the API key'
        : response.status === 404
          ? 'endpoint has no model listing'
          : response.statusText || 'request failed'
    return { models: [], error: `HTTP ${response.status} — ${hint}` }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { models: [], error: 'response was not JSON' }
  }
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const row of rowsFrom(payload)) {
    const model = normalizeRow(row)
    if (model === null || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  if (models.length === 0) {
    return { models: [], error: 'endpoint returned no models' }
  }
  return { models, error: null }
}

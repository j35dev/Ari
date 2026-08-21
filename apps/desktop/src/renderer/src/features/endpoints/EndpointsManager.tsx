import { useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from '@ari/ui/badge'
import type { BadgeTone } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Field } from '@ari/ui/field'
import { IconButton } from '@ari/ui/icon-button'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import type { SelectOption } from '@ari/ui/select'
import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'

/** API dialect spoken by an endpoint; drives auth headers and wire format. */
export type EndpointFlavor = 'openai-chat' | 'anthropic-messages' | 'ollama'

const FLAVORS: readonly EndpointFlavor[] = ['openai-chat', 'anthropic-messages', 'ollama']

const FLAVOR_SET: ReadonlySet<string> = new Set<string>(FLAVORS)

/** A custom model endpoint managed by the user for Ari Core. */
export interface ModelEndpoint {
  id: string
  name: string
  baseUrl: string
  flavor: EndpointFlavor
  model: string
  apiKey: string
}

/** localStorage key holding the JSON array of {@link ModelEndpoint} (includes apiKey). */
export const ENDPOINTS_STORAGE_KEY = 'ari.endpoints'

const FLAVOR_BADGES: Record<EndpointFlavor, { label: string; tone: BadgeTone }> = {
  'openai-chat': { label: 'OpenAI', tone: 'accent' },
  'anthropic-messages': { label: 'Anthropic', tone: 'success' },
  ollama: { label: 'Ollama', tone: 'neutral' },
}

const FLAVOR_OPTIONS: SelectOption[] = [
  { value: 'openai-chat', label: 'OpenAI chat-completions' },
  { value: 'anthropic-messages', label: 'Anthropic messages' },
  { value: 'ollama', label: 'Ollama' },
]

type TestResult = { status: 'ok'; latencyMs: number } | { status: 'error'; message: string }

type TestState = { phase: 'testing' } | { phase: 'done'; result: TestResult }

interface FormState {
  name: string
  baseUrl: string
  flavor: EndpointFlavor
  model: string
  apiKey: string
}

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  flavor: 'openai-chat',
  model: '',
  apiKey: '',
}

function createId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef != null && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID()
  }
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function parseFlavor(value: unknown): EndpointFlavor | null {
  if (typeof value !== 'string') return null
  return FLAVOR_SET.has(value) ? (value as EndpointFlavor) : null
}

function parseEndpoint(value: unknown): ModelEndpoint | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = record['id']
  const name = record['name']
  const baseUrl = record['baseUrl']
  const flavor = parseFlavor(record['flavor'])
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof baseUrl !== 'string' ||
    flavor === null
  ) {
    return null
  }
  return {
    id,
    name,
    baseUrl,
    flavor,
    model: typeof record['model'] === 'string' ? record['model'] : '',
    apiKey: typeof record['apiKey'] === 'string' ? record['apiKey'] : '',
  }
}

function loadEndpoints(): ModelEndpoint[] {
  try {
    const raw = window.localStorage.getItem(ENDPOINTS_STORAGE_KEY)
    if (raw == null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(parseEndpoint).filter((endpoint): endpoint is ModelEndpoint => endpoint != null)
  } catch {
    return []
  }
}

function persistEndpoints(endpoints: ModelEndpoint[]): void {
  window.localStorage.setItem(ENDPOINTS_STORAGE_KEY, JSON.stringify(endpoints))
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

interface EndpointCardProps {
  endpoint: ModelEndpoint
  testState: TestState | undefined
  onTest: (endpoint: ModelEndpoint) => void
  onEdit: (endpoint: ModelEndpoint) => void
  onDelete: (id: string) => void
}

function EndpointCard({ endpoint, testState, onTest, onEdit, onDelete }: EndpointCardProps) {
  const badge = FLAVOR_BADGES[endpoint.flavor]
  return (
    <li className="rounded-md border border-border bg-surface-1 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{endpoint.name}</span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-fg-muted">{endpoint.baseUrl}</p>
          {endpoint.model !== '' && (
            <p className="mt-0.5 truncate font-mono text-xs text-fg-subtle">{endpoint.model}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Test ${endpoint.name}`}
            onClick={() => onTest(endpoint)}
          >
            Test
          </Button>
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Pencil className="h-3.5 w-3.5" />}
            aria-label={`Edit ${endpoint.name}`}
            onClick={() => onEdit(endpoint)}
          />
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            aria-label={`Delete ${endpoint.name}`}
            onClick={() => onDelete(endpoint.id)}
          />
        </div>
      </div>
      {testState != null && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs">
          {testState.phase === 'testing' ? (
            <span className="text-fg-muted">Testing…</span>
          ) : testState.result.status === 'ok' ? (
            <>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              <span className="font-mono tabular-nums text-success">
                {testState.result.latencyMs}ms
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
              <span className="text-danger">{testState.result.message}</span>
            </>
          )}
        </p>
      )}
    </li>
  )
}

/**
 * Settings surface for Ari Core model endpoints: full CRUD over the
 * localStorage store (`ari.endpoints`) plus a per-endpoint connection probe
 * against `<baseUrl>/models`. Engine-backed persistence replaces localStorage
 * later; this component's contract stays the same.
 */
export function EndpointsManager() {
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>(loadEndpoints)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, TestState>>({})

  const updateField = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowApiKey(false)
    setFormError(null)
  }

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim()
    if (name === '' || !isHttpUrl(baseUrl)) {
      setFormError('Name and a valid http(s) base URL are required.')
      return
    }
    const model = form.model.trim()
    if (editingId != null) {
      const next = endpoints.map((endpoint) =>
        endpoint.id === editingId
          ? { ...endpoint, name, baseUrl, flavor: form.flavor, model, apiKey: form.apiKey }
          : endpoint,
      )
      setEndpoints(next)
      persistEndpoints(next)
    } else {
      const next: ModelEndpoint[] = [
        ...endpoints,
        { id: createId(), name, baseUrl, flavor: form.flavor, model, apiKey: form.apiKey },
      ]
      setEndpoints(next)
      persistEndpoints(next)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    const next = endpoints.filter((endpoint) => endpoint.id !== id)
    setEndpoints(next)
    persistEndpoints(next)
    setTestStates((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _removed, ...rest } = prev
      return rest
    })
    if (editingId === id) resetForm()
  }

  const startEdit = (endpoint: ModelEndpoint) => {
    setForm({
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      flavor: endpoint.flavor,
      model: endpoint.model,
      apiKey: endpoint.apiKey,
    })
    setEditingId(endpoint.id)
    setShowApiKey(false)
    setFormError(null)
  }

  const runTest = async (endpoint: ModelEndpoint) => {
    setTestStates((prev) => ({ ...prev, [endpoint.id]: { phase: 'testing' } }))
    try {
      // Only the OpenAI flavor authenticates /models with a bearer token;
      // Anthropic and Ollama endpoints are probed unauthenticated.
      const headers: Record<string, string> =
        endpoint.flavor === 'openai-chat' && endpoint.apiKey !== ''
          ? { Authorization: `Bearer ${endpoint.apiKey}` }
          : {}
      const startedAt = performance.now()
      const response = await fetch(modelsUrl(endpoint.baseUrl), { headers })
      const latencyMs = Math.round(performance.now() - startedAt)
      setTestStates((prev) => ({
        ...prev,
        [endpoint.id]: response.ok
          ? { phase: 'done', result: { status: 'ok', latencyMs } }
          : { phase: 'done', result: { status: 'error', message: `HTTP ${response.status}` } },
      }))
    } catch {
      // CORS and network failures both land here; browsers hide the cause.
      setTestStates((prev) => ({
        ...prev,
        [endpoint.id]: { phase: 'done', result: { status: 'error', message: 'unreachable' } },
      }))
    }
  }

  return (
    <section aria-label="Model endpoints" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-fg">Model endpoints</h2>
        {endpoints.length === 0 ? (
          <p className="text-xs text-fg-muted">No endpoints yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {endpoints.map((endpoint) => (
              <EndpointCard
                key={endpoint.id}
                endpoint={endpoint}
                testState={testStates[endpoint.id]}
                onTest={(endpoint) => void runTest(endpoint)}
                onEdit={startEdit}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
      <form
        onSubmit={handleSave}
        className="flex max-w-md flex-col gap-3 rounded-md border border-border bg-surface-1 p-3"
      >
        <h3 className="text-sm font-medium text-fg">
          {editingId != null ? 'Edit endpoint' : 'Add endpoint'}
        </h3>
        <Field label="Name">
          {(controlProps) => (
            <Input
              {...controlProps}
              value={form.name}
              onChange={(event) => updateField('name', event.target.value)}
              placeholder="Local llama"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Base URL" hint="Root of the API, e.g. http://localhost:8080/v1">
          {(controlProps) => (
            <Input
              {...controlProps}
              type="url"
              value={form.baseUrl}
              onChange={(event) => updateField('baseUrl', event.target.value)}
              placeholder="http://localhost:8080/v1"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Flavor">
          {() => (
            <Select
              value={form.flavor}
              onValueChange={(value) => {
                if (FLAVOR_SET.has(value)) updateField('flavor', value)
              }}
              options={FLAVOR_OPTIONS}
            />
          )}
        </Field>
        <Field label="Model">
          {(controlProps) => (
            <Input
              {...controlProps}
              value={form.model}
              onChange={(event) => updateField('model', event.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="API key" hint="Kept in local storage on this machine only; never logged.">
          {(controlProps) => (
            <Input
              {...controlProps}
              type={showApiKey ? 'text' : 'password'}
              value={form.apiKey}
              onChange={(event) => updateField('apiKey', event.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              trailing={
                <button
                  type="button"
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  aria-pressed={showApiKey}
                  onClick={() => setShowApiKey((visible) => !visible)}
                  className="rounded-sm p-0.5 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              }
            />
          )}
        </Field>
        {formError != null && (
          <p role="alert" className="text-xs text-danger">
            {formError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" size="sm">
            {editingId != null ? 'Save changes' : 'Add endpoint'}
          </Button>
          {editingId != null && (
            <Button type="button" variant="ghost" size="sm" onClick={resetForm}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}

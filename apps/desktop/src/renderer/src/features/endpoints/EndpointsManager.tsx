import { useCallback, useEffect, useState } from 'react'
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
import { rpc } from '../../lib/rpc'

/** API dialect spoken by an endpoint; drives auth headers and wire format. */
export type EndpointFlavor = 'openai-chat' | 'anthropic-messages' | 'ollama'

const FLAVORS: readonly EndpointFlavor[] = ['openai-chat', 'anthropic-messages', 'ollama']

const FLAVOR_SET: ReadonlySet<string> = new Set<string>(FLAVORS)

/** A model endpoint as stored by the engine (key material always redacted). */
export interface StoredEndpoint {
  id: string
  name: string
  baseUrl: string
  flavor: EndpointFlavor
  model: string
  hasKey: boolean
}

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

type ProbeResult = { ok: boolean; latencyMs: number; message: string }

type TestState = { phase: 'testing' } | { phase: 'done'; result: ProbeResult }

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

function parseStored(value: unknown): StoredEndpoint | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = record['id']
  const name = record['name']
  const baseUrl = record['baseUrl']
  const flavor = parseFlavor(record['flavor'])
  const model = record['model']
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof baseUrl !== 'string' ||
    flavor === null ||
    typeof model !== 'string'
  ) {
    return null
  }
  return {
    id,
    name,
    baseUrl,
    flavor,
    model,
    hasKey: record['apiKeyCipher'] != null,
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

interface EndpointCardProps {
  endpoint: StoredEndpoint
  testState: TestState | undefined
  onTest: (endpoint: StoredEndpoint) => void
  onEdit: (endpoint: StoredEndpoint) => void
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
          <p className="mt-0.5 truncate font-mono text-xs text-fg-subtle">
            {endpoint.model}
            {endpoint.hasKey ? ' · key saved' : ''}
          </p>
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
          ) : testState.result.ok ? (
            <>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              <span className="font-mono tabular-nums text-success">
                {testState.result.latencyMs}ms
              </span>
              <span className="text-fg-muted">{testState.result.message}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
              <span className="text-danger">
                {testState.result.message} · {testState.result.latencyMs}ms
              </span>
            </>
          )}
        </p>
      )}
    </li>
  )
}

/**
 * Settings surface for Ari Core model endpoints. Persistence lives in the
 * engine's encrypted endpoint store over IPC — keys never sit in localStorage
 * and never render back. Connection probes run in the main process.
 */
export function EndpointsManager() {
  const [endpoints, setEndpoints] = useState<StoredEndpoint[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, TestState>>({})

  const refresh = useCallback(async (): Promise<void> => {
    const stored = await rpc.invoke('endpoints.list')
    setEndpoints(stored.map(parseStored).filter((e): e is StoredEndpoint => e !== null))
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  const updateField = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowApiKey(false)
    setFormError(null)
  }

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim()
    const model = form.model.trim()
    if (name === '' || !isHttpUrl(baseUrl)) {
      setFormError('Name and a valid http(s) base URL are required.')
      return
    }
    if (model === '') {
      setFormError('A model id is required (e.g. gpt-4o-mini).')
      return
    }
    try {
      await rpc.invoke('endpoints.upsert', {
        id: editingId ?? createId(),
        name,
        baseUrl,
        flavor: form.flavor,
        model,
        // Blank key on edit keeps the stored one; blank on create clears.
        apiKey: form.apiKey.trim() === '' ? (editingId != null ? undefined : null) : form.apiKey.trim(),
        headers: {},
      })
      await refresh().catch(() => undefined)
      resetForm()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await rpc.invoke('endpoints.remove', { id })
    } finally {
      setTestStates((prev) => {
        if (!(id in prev)) return prev
        const { [id]: _removed, ...rest } = prev
        return rest
      })
      await refresh().catch(() => undefined)
      if (editingId === id) resetForm()
    }
  }

  const startEdit = (endpoint: StoredEndpoint) => {
    setForm({
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      flavor: endpoint.flavor,
      model: endpoint.model,
      apiKey: '',
    })
    setEditingId(endpoint.id)
    setShowApiKey(false)
    setFormError(null)
  }

  const runTest = useCallback(
    async (input: { baseUrl: string; flavor: EndpointFlavor }) => {
      const key = `${input.baseUrl}|${input.flavor}`
      setTestStates((prev) => ({ ...prev, [key]: { phase: 'testing' } }))
      try {
        const result = await rpc.invoke('endpoints.test', {
          baseUrl: input.baseUrl,
          flavor: input.flavor,
          apiKey: null,
        })
        setTestStates((prev) => ({ ...prev, [key]: { phase: 'done', result } }))
      } catch (e) {
        setTestStates((prev) => ({
          ...prev,
          [key]: {
            phase: 'done',
            result: {
              ok: false,
              latencyMs: 0,
              message: e instanceof Error ? e.message : String(e),
            },
          },
        }))
      }
    },
    [],
  )

  const testKeyFor = (baseUrl: string, flavor: EndpointFlavor): string => `${baseUrl}|${flavor}`

  return (
    <section aria-label="Model endpoints" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-fg">Model endpoints</h2>
        {endpoints.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No endpoints yet — add an OpenAI-compatible, Anthropic, or Ollama endpoint to chat
            through Ari Core.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {endpoints.map((endpoint) => (
              <EndpointCard
                key={endpoint.id}
                endpoint={endpoint}
                testState={testStates[testKeyFor(endpoint.baseUrl, endpoint.flavor)]}
                onTest={(endpoint) => void runTest(endpoint)}
                onEdit={startEdit}
                onDelete={(id) => void handleDelete(id)}
              />
            ))}
          </ul>
        )}
      </div>
      <form
        onSubmit={(e) => void handleSave(e)}
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
              placeholder="https://api.openai.com/v1"
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
        <Field
          label="API key"
          hint={
            editingId != null
              ? 'Leave blank to keep the saved key.'
              : 'Stored encrypted on this machine only; never logged.'
          }
        >
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
          {isHttpUrl(form.baseUrl.trim()) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                void runTest({ baseUrl: form.baseUrl.trim(), flavor: form.flavor })
              }
            >
              Test connection
            </Button>
          )}
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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { EndpointFlavor, EndpointModel } from '@ari/contracts/endpoint'
import { Badge } from '@ari/ui/badge'
import type { BadgeTone } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Field } from '@ari/ui/field'
import { IconButton } from '@ari/ui/icon-button'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import type { SelectOption } from '@ari/ui/select'
import { ChevronDown, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { ModelListEditor, type FetchState } from './ModelListEditor'

export type { EndpointFlavor }

const FLAVORS: readonly EndpointFlavor[] = ['openai-chat', 'anthropic-messages', 'ollama']

const FLAVOR_SET: ReadonlySet<string> = new Set<string>(FLAVORS)

/** A model endpoint as stored by the engine (key material always redacted). */
export interface StoredEndpoint {
  id: string
  name: string
  baseUrl: string
  flavor: EndpointFlavor
  /** Default model used when a session does not name one explicitly. */
  model: string
  models: EndpointModel[]
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
  apiKey: string
  models: EndpointModel[]
  defaultModel: string
}

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  flavor: 'openai-chat',
  apiKey: '',
  models: [],
  defaultModel: '',
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

/** Parses one stored model row, tolerating configs written before `models`. */
function parseModel(value: unknown): EndpointModel | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = record['id']
  if (typeof id !== 'string' || id === '') return null
  const contextWindow = record['contextWindow']
  return {
    id,
    label: typeof record['label'] === 'string' && record['label'] !== '' ? record['label'] : id,
    contextWindow: typeof contextWindow === 'number' ? contextWindow : null,
    source: record['source'] === 'discovered' ? 'discovered' : 'manual',
  }
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
  const rawModels = Array.isArray(record['models']) ? record['models'] : []
  const models = rawModels.map(parseModel).filter((m): m is EndpointModel => m !== null)
  return {
    id,
    name,
    baseUrl,
    flavor,
    model,
    // The engine guarantees the default is present; be defensive anyway so a
    // hand-edited config still renders one selectable model.
    models: models.some((m) => m.id === model)
      ? models
      : [{ id: model, label: model, contextWindow: null, source: 'manual' }, ...models],
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
  fetchState: FetchState | undefined
  expanded: boolean
  onToggleModels: (id: string) => void
  onModelsChange: (id: string, next: { models: EndpointModel[]; defaultModel: string }) => void
  onFetchModels: (endpoint: StoredEndpoint) => void
  onTest: (endpoint: StoredEndpoint) => void
  onEdit: (endpoint: StoredEndpoint) => void
  onDelete: (id: string) => void
}

function EndpointCard({
  endpoint,
  testState,
  fetchState,
  expanded,
  onToggleModels,
  onModelsChange,
  onFetchModels,
  onTest,
  onEdit,
  onDelete,
}: EndpointCardProps) {
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
            {endpoint.models.length} model{endpoint.models.length === 1 ? '' : 's'} · default{' '}
            {endpoint.model}
            {endpoint.hasKey ? ' · key saved' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Manage'} models for ${endpoint.name}`}
            onClick={() => onToggleModels(endpoint.id)}
          >
            Models
            <ChevronDown
              className={`ms-1 h-3 w-3 transition-transform duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </Button>
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
      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          <ModelListEditor
            models={endpoint.models}
            defaultModel={endpoint.model}
            onChange={(next) => onModelsChange(endpoint.id, next)}
            onFetch={() => onFetchModels(endpoint)}
            fetchState={fetchState}
            scopeLabel={endpoint.name}
          />
        </div>
      )}
    </li>
  )
}

/**
 * Settings surface for Ari Core model endpoints. Persistence lives in the
 * engine's encrypted endpoint store over IPC — keys never sit in localStorage
 * and never render back. Connection probes and model discovery run in the main
 * process, since the sandboxed renderer cannot reach arbitrary origins.
 *
 * Each endpoint holds a list of models: a fetch imports every id the
 * listing API returns (unwanted ones are deleted afterwards), or ids are
 * added by hand, with one marked as the endpoint default. The add form sits
 * above the saved list so a long catalog cannot bury it.
 */
export function EndpointsManager() {
  const [endpoints, setEndpoints] = useState<StoredEndpoint[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, TestState>>({})
  const [fetchStates, setFetchStates] = useState<Record<string, FetchState>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const stored = await rpc.invoke('endpoints.list')
    setEndpoints(stored.map(parseStored).filter((e): e is StoredEndpoint => e !== null))
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  const updateField = (field: 'name' | 'baseUrl' | 'apiKey' | 'flavor', value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowApiKey(false)
    setFormError(null)
    setFetchStates((prev) => {
      const { form: _dropped, ...rest } = prev
      return rest
    })
  }

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim()
    if (name === '' || !isHttpUrl(baseUrl)) {
      setFormError('Name and a valid http(s) base URL are required.')
      return
    }
    const defaultModel = form.defaultModel !== '' ? form.defaultModel : (form.models[0]?.id ?? '')
    if (defaultModel === '') {
      setFormError('Add at least one model — fetch them from the endpoint or type an id.')
      return
    }
    try {
      await rpc.invoke('endpoints.upsert', {
        id: editingId ?? createId(),
        name,
        baseUrl,
        flavor: form.flavor,
        model: defaultModel,
        models: form.models,
        // Blank key on edit keeps the stored one; blank on create clears.
        apiKey:
          form.apiKey.trim() === '' ? (editingId != null ? undefined : null) : form.apiKey.trim(),
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
      if (expandedId === id) setExpandedId(null)
      await refresh().catch(() => undefined)
      if (editingId === id) resetForm()
    }
  }

  const startEdit = (endpoint: StoredEndpoint) => {
    setForm({
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      flavor: endpoint.flavor,
      apiKey: '',
      models: endpoint.models,
      defaultModel: endpoint.model,
    })
    setEditingId(endpoint.id)
    setShowApiKey(false)
    setFormError(null)
    formRef.current?.scrollIntoView?.({ block: 'start' })
  }

  const runTest = useCallback(
    async (input: { id?: string; baseUrl: string; flavor: EndpointFlavor; apiKey?: string }) => {
      const key = `${input.baseUrl}|${input.flavor}`
      setTestStates((prev) => ({ ...prev, [key]: { phase: 'testing' } }))
      try {
        const result = await rpc.invoke('endpoints.test', {
          ...(input.id !== undefined ? { id: input.id } : {}),
          baseUrl: input.baseUrl,
          flavor: input.flavor,
          // A saved endpoint's key comes from the store via `id`; a key typed in
          // the form is not saved yet, so it rides along here.
          apiKey: input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : null,
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

  /**
   * Asks an endpoint for its model list. With an `id` the engine persists the
   * merged list (keeping manual entries) and we re-read it; without one the
   * models land in the add-endpoint form unsaved.
   */
  const fetchModels = useCallback(
    async (input: {
      stateKey: string
      id?: string
      baseUrl: string
      flavor: EndpointFlavor
      apiKey?: string
      /** False for the form: probe without saving an unsubmitted endpoint. */
      persist?: boolean
    }) => {
      const persist = input.persist ?? true
      setFetchStates((prev) => ({ ...prev, [input.stateKey]: { phase: 'fetching' } }))
      try {
        const result = await rpc.invoke('endpoints.discoverModels', {
          ...(input.id !== undefined ? { id: input.id } : {}),
          baseUrl: input.baseUrl,
          flavor: input.flavor,
          // A saved endpoint's key lives in the engine; a key typed in the form
          // is not stored yet, so it has to ride along or discovery 401s.
          apiKey: input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : null,
          persist,
        })
        setFetchStates((prev) => ({
          ...prev,
          [input.stateKey]: {
            phase: 'done',
            found: result.models.length,
            error: result.error,
          },
        }))
        if (result.models.length === 0) return
        if (persist) {
          // The engine already merged and saved; re-read rather than guess.
          await refresh().catch(() => undefined)
          return
        }
        const discovered: EndpointModel[] = result.models.map((model) => ({
          id: model.id,
          label: model.label,
          contextWindow: model.contextWindow,
          source: 'discovered',
        }))
        setForm((prev) => {
          // Merge over what is already listed so a re-fetch is idempotent and
          // never drops a model the user typed in first.
          const byId = new Map(discovered.map((m) => [m.id, m]))
          for (const kept of prev.models) if (!byId.has(kept.id)) byId.set(kept.id, kept)
          const models = [...byId.values()]
          return {
            ...prev,
            models,
            defaultModel: prev.defaultModel !== '' ? prev.defaultModel : (models[0]?.id ?? ''),
          }
        })
      } catch (e) {
        setFetchStates((prev) => ({
          ...prev,
          [input.stateKey]: {
            phase: 'done',
            found: 0,
            error: e instanceof Error ? e.message : String(e),
          },
        }))
      }
    },
    [refresh],
  )

  /** Persists a model-list edit made directly on a saved endpoint's card. */
  const saveEndpointModels = useCallback(
    async (id: string, next: { models: EndpointModel[]; defaultModel: string }) => {
      // Optimistic: the card is the source of truth the user is looking at.
      setEndpoints((prev) =>
        prev.map((e) =>
          e.id === id
            ? { ...e, models: next.models, model: next.defaultModel || e.model }
            : e,
        ),
      )
      try {
        await rpc.invoke('endpoints.setModels', {
          id,
          models: next.models,
          ...(next.defaultModel !== '' ? { defaultModel: next.defaultModel } : {}),
        })
      } finally {
        await refresh().catch(() => undefined)
      }
    },
    [refresh],
  )

  const testKeyFor = (baseUrl: string, flavor: EndpointFlavor): string => `${baseUrl}|${flavor}`
  const formBaseUrl = form.baseUrl.trim()

  return (
    <section aria-label="Model endpoints" className="flex flex-col gap-6">
      <form
        ref={formRef}
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
          {isHttpUrl(formBaseUrl) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                void runTest({
                  baseUrl: formBaseUrl,
                  flavor: form.flavor,
                  ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {}),
                })
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
        <div className="border-t border-border pt-3">
          <ModelListEditor
            models={form.models}
            defaultModel={form.defaultModel}
            onChange={(next) =>
              setForm((prev) => ({
                ...prev,
                models: next.models,
                defaultModel: next.defaultModel,
              }))
            }
            onFetch={
              isHttpUrl(formBaseUrl)
                ? () =>
                    void fetchModels({
                      stateKey: 'form',
                      baseUrl: formBaseUrl,
                      flavor: form.flavor,
                      // While editing, `id` lets the engine supply the stored
                      // key; `persist: false` keeps the probe out of the store
                      // until the form is actually submitted.
                      ...(editingId != null ? { id: editingId } : {}),
                      ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {}),
                      persist: false,
                    })
                : null
            }
            fetchState={fetchStates['form']}
            scopeLabel={editingId != null ? 'this endpoint' : 'the new endpoint'}
          />
        </div>
      </form>
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-fg">Saved endpoints</h2>
        {endpoints.length === 0 ? (
          <p className="text-xs text-fg-muted">
            None yet — add an OpenAI-compatible, Anthropic, or Ollama endpoint above to chat
            through Ari Core.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {endpoints.map((endpoint) => (
              <EndpointCard
                key={endpoint.id}
                endpoint={endpoint}
                testState={testStates[testKeyFor(endpoint.baseUrl, endpoint.flavor)]}
                fetchState={fetchStates[endpoint.id]}
                expanded={expandedId === endpoint.id}
                onToggleModels={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                onModelsChange={(id, next) => void saveEndpointModels(id, next)}
                onFetchModels={(target) =>
                  void fetchModels({
                    stateKey: target.id,
                    id: target.id,
                    baseUrl: target.baseUrl,
                    flavor: target.flavor,
                  })
                }
                onTest={(target) => void runTest(target)}
                onEdit={startEdit}
                onDelete={(id) => void handleDelete(id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

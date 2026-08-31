import { useState } from 'react'
import type { EndpointModel } from '@ari/contracts/endpoint'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { IconButton } from '@ari/ui/icon-button'
import { Input } from '@ari/ui/input'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'

/** State of a model-discovery request against one endpoint. */
export type FetchState =
  | { phase: 'fetching' }
  | { phase: 'done'; found: number; error: string | null }

export interface ModelListEditorProps {
  models: EndpointModel[]
  /** Model used when a session does not name one; always one of `models`. */
  defaultModel: string
  onChange: (next: { models: EndpointModel[]; defaultModel: string }) => void
  /** Asks the endpoint what it serves; absent while the base URL is invalid. */
  onFetch: (() => void) | null
  fetchState: FetchState | undefined
  /** Disambiguates the default-model radio group across mounted editors. */
  idPrefix: string
  /**
   * Endpoint this editor belongs to, woven into every control's accessible
   * name — the settings page mounts one editor per card plus one in the form.
   */
  scopeLabel: string
}

function contextHint(model: EndpointModel): string | null {
  if (model.contextWindow === null) return null
  const k = Math.round(model.contextWindow / 1000)
  return k >= 1 ? `${k}k ctx` : `${model.contextWindow} ctx`
}

/**
 * Editor for the set of models one endpoint serves. Models arrive two ways:
 * fetched from the endpoint's own listing API, or typed in by hand — and the
 * two are kept distinguishable so a refresh never deletes a manual entry.
 * Exactly one model is the endpoint's default.
 */
export function ModelListEditor({
  models,
  defaultModel,
  onChange,
  onFetch,
  fetchState,
  idPrefix,
  scopeLabel,
}: ModelListEditorProps) {
  const [draft, setDraft] = useState('')

  const addManual = (): void => {
    const id = draft.trim()
    if (id === '') return
    if (models.some((m) => m.id === id)) {
      setDraft('')
      return
    }
    const next: EndpointModel[] = [
      ...models,
      { id, label: id, contextWindow: null, source: 'manual' },
    ]
    onChange({ models: next, defaultModel: defaultModel === '' ? id : defaultModel })
    setDraft('')
  }

  const remove = (id: string): void => {
    const next = models.filter((m) => m.id !== id)
    // Removing the default hands the role to whatever is left.
    const nextDefault = id === defaultModel ? (next[0]?.id ?? '') : defaultModel
    onChange({ models: next, defaultModel: nextDefault })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg">
          Models{models.length > 0 ? ` · ${models.length}` : ''}
        </span>
        {onFetch !== null && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={`Fetch models for ${scopeLabel}`}
            onClick={onFetch}
            disabled={fetchState?.phase === 'fetching'}
          >
            <RefreshCw
              className={`me-1 h-3 w-3 ${fetchState?.phase === 'fetching' ? 'animate-spin motion-reduce:animate-none' : ''}`}
              aria-hidden
            />
            {fetchState?.phase === 'fetching' ? 'Fetching…' : 'Fetch from endpoint'}
          </Button>
        )}
      </div>

      {fetchState !== undefined && (
        <p role="status" className="text-xs">
          {fetchState.phase === 'fetching' ? (
            <span className="text-fg-muted">Asking the endpoint for its model list…</span>
          ) : fetchState.error !== null ? (
            <span className="text-danger">Could not fetch models: {fetchState.error}</span>
          ) : (
            <span className="text-success">
              Found {fetchState.found} model{fetchState.found === 1 ? '' : 's'}.
            </span>
          )}
        </p>
      )}

      {models.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No models yet — fetch them from the endpoint or add a model id by hand.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {models.map((model) => (
            <li key={model.id} className="flex items-center gap-2">
              <label
                htmlFor={`${idPrefix}-${model.id}`}
                className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2"
              >
                <input
                  type="radio"
                  name={`${idPrefix}-default-model`}
                  id={`${idPrefix}-${model.id}`}
                  checked={model.id === defaultModel}
                  onChange={() => onChange({ models, defaultModel: model.id })}
                  className="peer sr-only"
                />
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-1 transition-colors peer-checked:border-accent peer-checked:bg-accent peer-checked:[&>span]:opacity-100 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-fg-on-accent opacity-0" />
                </span>
                <span className="truncate font-mono text-xs text-fg">{model.id}</span>
                {model.label !== model.id && (
                  <span className="truncate text-2xs text-fg-muted">{model.label}</span>
                )}
                {contextHint(model) !== null && (
                  <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                    {contextHint(model)}
                  </span>
                )}
                {model.source === 'manual' && <Badge tone="neutral">manual</Badge>}
              </label>
              <IconButton
                size="sm"
                variant="ghost"
                icon={<Trash2 className="h-3 w-3" />}
                aria-label={`Remove model ${model.id} from ${scopeLabel}`}
                onClick={() => remove(model.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`Model id to add to ${scopeLabel}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addManual()
            }
          }}
          placeholder="gpt-4o-mini"
          autoComplete="off"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Add model to ${scopeLabel}`}
          onClick={addManual}
          disabled={draft.trim() === ''}
        >
          <Plus className="me-1 h-3 w-3" aria-hidden />
          Add
        </Button>
      </div>

      {models.length > 0 && (
        <p className="text-2xs text-fg-subtle">
          The selected model is used when a session does not pick one. All models here appear in
          the session model picker.
        </p>
      )}
    </div>
  )
}

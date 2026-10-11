import { useState, type ReactNode } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { useApp } from '../lib/app-state'
import { BottomSheet, SearchField } from './ui'

const names: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  hermes: 'Hermes',
  'ari-core': 'Ari Core',
}

/** A provider as the user knows it; an id this build has no name for stays visible. */
export function providerName(driverKind: string): string {
  return names[driverKind] ?? driverKind
}

/** Human labels come from the desktop catalog; unknown IDs remain visible. */
export function modelSelectionLabel(
  catalog: RemoteModelCatalog | null,
  driverKind: string,
  modelId: string,
): string {
  if (!driverKind) {
    const defaults = catalog?.defaults
    if (!defaults?.driverKind) return 'Desktop default'
    const model = catalog?.providers
      .find((entry) => entry.driverKind === defaults.driverKind)
      ?.models.find((entry) => entry.id === defaults.modelId)
    return `Desktop default · ${model?.label ?? names[defaults.driverKind] ?? defaults.driverKind}`
  }
  const provider = catalog?.providers.find((entry) => entry.driverKind === driverKind)
  const model = provider?.models.find((entry) => entry.id === modelId)
  return `${names[driverKind] ?? driverKind} · ${model?.label ?? (modelId || 'Default model')}`
}

/** A session's chip: the model alone, or the provider when the session uses its default. */
export function modelChipLabel(
  catalog: RemoteModelCatalog | null,
  driverKind: string,
  modelId: string,
): string {
  if (!modelId) return names[driverKind] ?? driverKind
  const provider = catalog?.providers.find((entry) => entry.driverKind === driverKind)
  return provider?.models.find((entry) => entry.id === modelId)?.label ?? modelId
}

/** One searchable picker for new sessions and the current session's native provider. */
export function ModelPicker({
  driverKind,
  modelId,
  fixedProvider = false,
  onSelect,
  onClose,
}: {
  driverKind: string
  modelId: string
  fixedProvider?: boolean
  onSelect: (driverKind: string, modelId: string) => void
  onClose: () => void
}): ReactNode {
  const app = useApp()
  const [providerId, setProviderId] = useState(
    driverKind || app.catalog?.defaults?.driverKind || app.catalog?.providers[0]?.driverKind || '',
  )
  const [query, setQuery] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const provider = app.catalog?.providers.find((entry) => entry.driverKind === providerId)
  const available = provider !== undefined && provider.available !== false
  const needle = query.trim().toLowerCase()
  const models = (provider?.models ?? []).filter((model) =>
    `${model.label} ${model.id} ${(model.aliases ?? []).join(' ')}`.toLowerCase().includes(needle),
  )
  const choose = (nextDriver: string, nextModel: string): void => {
    onSelect(nextDriver, nextModel)
    onClose()
  }
  return (
    <BottomSheet title={fixedProvider ? 'Choose model' : 'Agent & model'} onClose={onClose}>
      {!fixedProvider && (
        <>
          <button
            type="button"
            className="mb-3 flex min-h-14 w-full items-center gap-3 rounded-xl bg-surface-1 px-3 text-left"
            disabled={app.catalog?.defaults?.driverKind === null}
            onClick={() => choose('', '')}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Desktop default</span>
              <span className="mt-0.5 block truncate text-xs text-fg-muted">
                {app.catalog?.defaults?.driverKind
                  ? modelSelectionLabel(
                      app.catalog,
                      app.catalog.defaults.driverKind,
                      app.catalog.defaults.modelId ?? '',
                    )
                  : 'Use the agent configured on your computer'}
              </span>
            </span>
            {driverKind === '' && <Check size={16} className="text-accent" />}
          </button>
          <div
            role="group"
            aria-label="Agents on your computer"
            className="mb-4 flex gap-1 overflow-x-auto"
          >
            {app.catalog?.providers.map((entry) => (
              <button
                key={entry.driverKind}
                type="button"
                aria-pressed={providerId === entry.driverKind}
                onClick={() => {
                  setProviderId(entry.driverKind)
                  setQuery('')
                }}
                className={`min-h-11 shrink-0 rounded-lg px-3 text-xs ${providerId === entry.driverKind ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted'} ${entry.available === false ? 'opacity-50' : ''}`}
              >
                {names[entry.driverKind] ?? entry.driverKind}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="sticky top-0 z-10 bg-surface-0 py-1">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Find a model"
          label="Search models"
        />
      </div>
      <div className="mt-3 min-h-40">
        {!available ? (
          <p role="status" className="py-4 text-sm leading-relaxed text-fg-muted">
            {provider?.reason ??
              'No available agent reported by your computer. Check desktop provider settings.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {!needle && (
              <li>
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 py-3 text-left"
                  onClick={() => choose(providerId, '')}
                >
                  <span className="flex-1 text-sm">Provider default</span>
                  {driverKind === providerId && modelId === '' && (
                    <Check size={16} className="text-accent" />
                  )}
                </button>
              </li>
            )}
            {models.map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 py-3 text-left"
                  onClick={() => choose(providerId, model.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">{model.label}</span>
                    {model.id !== model.label && (
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-fg-subtle">
                        {model.id}
                      </span>
                    )}
                  </span>
                  {driverKind === providerId && modelId === model.id ? (
                    <Check size={16} className="shrink-0 text-accent" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {available && models.length === 0 && needle && (
          <p className="py-4 text-sm text-fg-muted">No matching models.</p>
        )}
      </div>
      {failure !== null && (
        <p role="alert" className="error-banner">
          {failure}
        </p>
      )}
      <button
        type="button"
        className="mt-3 flex min-h-11 items-center gap-2 text-xs text-fg-muted"
        disabled={app.refreshing}
        onClick={() => {
          setFailure(null)
          void app
            .refresh()
            .catch((error: unknown) =>
              setFailure(
                error instanceof Error ? error.message : 'Could not refresh the desktop catalog.',
              ),
            )
        }}
      >
        <RefreshCw size={13} className={app.refreshing ? 'animate-spin' : ''} />
        {app.refreshing ? 'Syncing with desktop…' : 'Refresh from desktop'}
      </button>
    </BottomSheet>
  )
}

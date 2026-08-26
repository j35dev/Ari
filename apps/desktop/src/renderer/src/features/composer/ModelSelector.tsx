import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import type { CatalogModelInfo } from '@ari/contracts/rpc'
import { modelsFor } from '@ari/providers/catalogs'
import { rpc } from '../../lib/rpc'
import { driverLabel } from './agent-mark'
import { ProviderLogo } from './provider-logo'

export interface SelectorOption {
  id: string
  label: string
  group: string
  hint?: string
}

/** Live catalogs by kind; absent kinds fall back to the bundled snapshot. */
type CatalogByKind = Partial<Record<DriverKind, CatalogModelInfo[]>>

/** One left-rail entry: an installed provider and how many models it serves. */
interface ProviderRow {
  kind: DriverKind
  label: string
  count: number
}

/** Cross-provider search hits, grouped under their provider header. */
interface ResultGroup {
  kind: DriverKind
  label: string
  /** Index of the group's first option in the flat keyboard order. */
  start: number
  options: SelectorOption[]
}

/**
 * Two-pane model picker: a provider rail on the left, the active provider's
 * models on the right — no drill-in step, every model is one click away.
 * Search cuts across all providers into one grouped flat list. Arrows move
 * the selection, Left/Right switch provider, Enter picks, Esc closes.
 *
 * `lockedTo` hides the rail and pins the pane to one provider (a session that
 * already ran turns must stay on its harness, or the provider-side resume
 * thread and the transcript's context story break). New sessions can still
 * pick any provider.
 */
export function ModelSelector({
  driverKind,
  modelId,
  onChange,
  lockedTo = null,
}: {
  driverKind: DriverKind
  modelId: string | null
  onChange: (next: { driverKind: DriverKind; modelId: string | null }) => void
  /** When set, only this provider's models are selectable. */
  lockedTo?: DriverKind | null
}) {
  const [open, setOpen] = useState(false)
  const [activeKind, setActiveKind] = useState<DriverKind | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [drivers, setDrivers] = useState<{ kind: DriverKind; label: string }[]>([])
  const [catalog, setCatalog] = useState<CatalogByKind>({})
  const [endpointModels, setEndpointModels] = useState<SelectorOption[]>([])
  const [loaded, setLoaded] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const activeId = `${listboxId}-opt-${activeIndex}`

  /** Drivers + model catalogs; cheap enough to re-run on every picker open so
   * late-landing ACP probes (which spawn the agent CLI) show up without a
   * restart. */
  const loadCatalogs = useCallback(() => {
    void Promise.allSettled([
      rpc.invoke('providers.detect').then((detections) => {
        setDrivers(
          detections
            .filter((d) => d.binaryPath !== null || d.kind === 'ari-core')
            .map((d) => ({
              kind: d.kind as DriverKind,
              label: driverLabel(d.kind),
            })),
        )
      }),
      rpc.invoke('providers.models').then((rows) => {
        const byKind: CatalogByKind = {}
        // Every source is usable: snapshot/cache are curated to what each CLI
        // currently serves and `live` rows are the harness's own model list.
        for (const row of rows) byKind[row.kind as DriverKind] = row.models
        setCatalog(byKind)
      }),
      rpc.invoke('endpoints.list').then((endpoints) => {
        setEndpointModels(
          endpoints.map((e) => ({
            id: `ep:${e.id}`,
            label: e.name,
            group: 'Ari Core',
            hint: e.model,
          })),
        )
      }),
    ]).finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    loadCatalogs()
  }, [loadCatalogs])

  /** Models for one provider — the right-hand pane. */
  const optionsFor = useMemo(() => {
    const compute = (kind: DriverKind): SelectorOption[] => {
      if (kind === 'ari-core') return endpointModels
      // The catalog is already scoped to what this CLI serves; when it is
      // genuinely empty fall back to the CLI's own default rather than nothing.
      const live = catalog[kind]
      const list = live && live.length > 0 ? live : modelsFor(kind)
      return list.map((model) => ({
        id: `${kind}:${model.id}`,
        label: model.label,
        group: driverLabel(kind),
        hint: model.contextHint,
      }))
    }
    return compute
  }, [catalog, endpointModels])

  const currentId = `${driverKind}:${modelId ?? ''}`
  const currentKindLabel = driverLabel(driverKind)

  const providers = useMemo<ProviderRow[]>(
    () => drivers.map((driver) => ({ ...driver, count: optionsFor(driver.kind).length })),
    [drivers, optionsFor],
  )

  const searching = query.trim().length > 0

  /** Pane rows: every model of the active provider, in catalog order. */
  const paneModels = useMemo(
    () => (activeKind === null ? [] : optionsFor(activeKind)),
    [activeKind, optionsFor],
  )

  /** Search rows: matching models from every provider, grouped, flat order. */
  const results = useMemo<ResultGroup[]>(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const groups: ResultGroup[] = []
    let start = 0
    for (const provider of providers) {
      const options = optionsFor(provider.kind).filter(
        (o) => o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false),
      )
      if (options.length > 0) {
        groups.push({ kind: provider.kind, label: provider.label, start, options })
        start += options.length
      }
    }
    return groups
  }, [providers, optionsFor, query])

  /** Flat keyboard order: pane rows normally, grouped hits while searching. */
  const flatOptions = useMemo(
    () => (searching ? results.flatMap((g) => g.options) : paneModels),
    [searching, results, paneModels],
  )
  const visibleCount = flatOptions.length

  /** Provider the pane opens on: the session's current one (or the lock). */
  const defaultKind = useMemo<DriverKind | null>(() => {
    if (drivers.length === 0) return null
    const wanted = lockedTo ?? driverKind
    return drivers.some((d) => d.kind === wanted) ? wanted : (drivers[0]?.kind ?? null)
  }, [drivers, lockedTo, driverKind])

  useEffect(() => {
    if (!open) return
    if (activeKind === null && defaultKind !== null) setActiveKind(defaultKind)
    setActiveIndex(0)
    // Focus synchronously: a deferred (rAF) focus let keystrokes land on
    // <body> when they were dispatched between commit and the frame callback.
    searchRef.current?.focus()
  }, [open, query, activeKind, defaultKind])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const close = (): void => {
    setOpen(false)
    setQuery('')
    setActiveKind(null)
  }

  const pickModel = (opt: SelectorOption): void => {
    // Endpoint options carry `ep:<endpointId>`; they ride the ari-core driver,
    // never a CLI kind — splitting on ':' would send driverKind 'ep' and fail
    // session.create validation (seen after adding a custom endpoint).
    if (opt.id.startsWith('ep:')) {
      onChange({ driverKind: 'ari-core', modelId: opt.id })
      close()
      return
    }
    const [kind, ...rest] = opt.id.split(':')
    onChange({ driverKind: kind as DriverKind, modelId: rest.join(':') || null })
    close()
  }

  const switchProvider = (step: 1 | -1): void => {
    if (lockedTo !== null || providers.length === 0) return
    const at = Math.max(0, providers.findIndex((p) => p.kind === activeKind))
    const next = providers[(at + step + providers.length) % providers.length]
    if (next !== undefined) {
      setActiveKind(next.kind)
      setQuery('')
    }
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowLeft') {
      if (searching) return // caret movement in the query wins over rail switching
      e.preventDefault()
      switchProvider(-1)
      return
    }
    if (e.key === 'ArrowRight') {
      if (searching) return
      e.preventDefault()
      switchProvider(1)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(Math.max(visibleCount - 1, 0), i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(Math.max(visibleCount - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = flatOptions[activeIndex]
      if (opt !== undefined) pickModel(opt)
    }
  }

  const triggerLabel = useMemo(() => {
    if (driverKind === 'ari-core') {
      // Show the endpoint's name, not its raw `ep:<id>` handle.
      const endpoint = endpointModels.find((e) => e.id === modelId)
      return endpoint?.label ?? modelId ?? 'Ari Core'
    }
    const list = optionsFor(driverKind)
    return list.find((o) => o.id === currentId)?.label ?? modelId ?? 'CLI default'
  }, [driverKind, modelId, currentId, optionsFor, endpointModels])

  const rowClasses = (isActive: boolean): string =>
    `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
      isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted'
    }`

  const optionRow = (opt: SelectorOption, index: number, markKind: string | null) => {
    const isSelected = opt.id === currentId
    return (
      <button
        key={opt.id}
        id={`${listboxId}-opt-${index}`}
        type="button"
        role="option"
        aria-selected={isSelected}
        data-option-index={index}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => pickModel(opt)}
        className={rowClasses(index === activeIndex)}
      >
        {markKind !== null ? <ProviderLogo kind={markKind} /> : null}
        <span className="min-w-0 flex-1 truncate text-xs">{opt.label}</span>
        {opt.hint ? (
          <span className="shrink-0 font-mono text-2xs text-fg-subtle">{opt.hint}</span>
        ) : null}
        {isSelected ? <Check size={12} className="shrink-0 text-fg" aria-hidden /> : null}
      </button>
    )
  }

  const emptyState = (
    <p className="px-2 py-3 text-center text-xs text-fg-subtle">
      {!loaded
        ? 'Loading…'
        : drivers.length === 0
          ? 'No agents detected yet.'
          : searching
            ? `No models match “${query.trim()}”.`
            : 'No models available.'}
    </p>
  )

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => {
          if (open) {
            close()
            return
          }
          setOpen(true)
          setActiveKind(lockedTo ?? defaultKind)
          loadCatalogs()
        }}
        aria-label={`Model: ${currentKindLabel} · ${triggerLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 w-full max-w-52 items-center gap-1.5 rounded-md border border-border bg-surface-1 pe-2 ps-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ProviderLogo kind={driverKind} />
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ChevronDown
          size={11}
          aria-hidden
          className={`shrink-0 text-fg-subtle transition-transform duration-[var(--ari-dur-fast)] ease-[var(--ari-ease-out-expo)] motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            role="presentation"
            onKeyDown={onMenuKeyDown}
            className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 flex w-[25rem] flex-col overflow-hidden rounded-lg border border-border shadow-2"
          >
            <div className="relative border-b border-border">
              <Search
                size={12}
                aria-hidden
                className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                aria-label="Search models"
                aria-controls={listboxId}
                aria-activedescendant={visibleCount > 0 ? activeId : undefined}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded
                autoComplete="off"
                spellCheck={false}
                className="h-8 w-full bg-transparent pe-2 ps-7 text-xs text-fg placeholder:text-fg-subtle focus:outline-none"
              />
            </div>

            {searching ? (
              <div
                ref={listRef}
                id={listboxId}
                role="listbox"
                aria-label="Search results"
                className="ari-scroll max-h-80 overflow-y-auto p-1"
              >
                {visibleCount === 0
                  ? emptyState
                  : results.map((group) => (
                      <div key={group.kind} role="presentation">
                        <p className="px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
                          {group.label} · {group.options.length}
                        </p>
                        {group.options.map((opt, i) => optionRow(opt, group.start + i, group.kind))}
                      </div>
                    ))}
              </div>
            ) : (
              <div className="flex min-h-0">
                {lockedTo === null && providers.length > 0 ? (
                  <div
                    role="presentation"
                    aria-label="Providers"
                    className="w-28 shrink-0 border-e border-border p-1"
                  >
                    {providers.map((provider) => (
                      <button
                        key={provider.kind}
                        type="button"
                        aria-current={provider.kind === activeKind}
                        onClick={() => {
                          setActiveKind(provider.kind)
                          setQuery('')
                        }}
                        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
                          provider.kind === activeKind
                            ? 'bg-surface-2 text-fg'
                            : 'text-fg-muted hover:text-fg'
                        }`}
                      >
                        <ProviderLogo kind={provider.kind} />
                        <span className="min-w-0 flex-1 truncate text-left text-xs">
                          {provider.label}
                        </span>
                        <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                          {provider.count}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <div
                  ref={listRef}
                  id={listboxId}
                  role="listbox"
                  aria-label="Models"
                  className="ari-scroll max-h-80 min-w-0 flex-1 overflow-y-auto p-1"
                >
                  {visibleCount === 0
                    ? emptyState
                    : paneModels.map((opt, index) => optionRow(opt, index, null))}
                </div>
              </div>
            )}

            {lockedTo !== null ? (
              <p className="border-t border-border px-2 py-1.5 text-2xs leading-relaxed text-fg-subtle">
                This session runs on {driverLabel(lockedTo)}. Start a new session to use another agent.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

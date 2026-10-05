import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import type { CatalogModelInfo } from '@ari/contracts/rpc'
import { modelsFor } from '@ari/providers/catalogs'
import type { CatalogSource } from '@ari/providers/catalogs'
import { rpc } from '../../lib/rpc'
import { driverLabel } from './agent-mark'
import { partitionProviders } from './provider-readiness'
import type { ProviderReadiness } from './provider-readiness'
import { ProviderLogo } from './provider-logo'

export interface SelectorOption {
  id: string
  label: string
  group: string
  hint?: string
  /** One-line summary in the agent's own words, set under the label. */
  description?: string
  /** Other ids that resolve to this same model; matched when marking selection. */
  aliases?: string[]
  /** Superseded within its family; hidden behind the picker's disclosure. */
  isLegacy?: boolean
}

/** True when an option is the current one, following version-less aliases. */
function matchesCurrent(option: SelectorOption, currentId: string): boolean {
  if (option.id === currentId || (option.aliases?.includes(currentId) ?? false)) return true
  // No saved model means the agent's own default, which is its `default` row.
  return currentId.endsWith(':') && option.id === `${currentId}default`
}

/**
 * Agents mark their suggested row in the name itself ("Default (recommended)");
 * the note reads better as a tag beside the name than as part of it.
 */
function splitRecommended(label: string): { name: string; recommended: boolean } {
  const tagged = /^(.+?)\s*\(recommended\)$/i.exec(label)
  return { name: tagged?.[1] ?? label, recommended: tagged !== null }
}

/** Live catalogs by kind; absent kinds fall back to the bundled snapshot. */
type CatalogByKind = Partial<Record<DriverKind, CatalogModelInfo[]>>

/** Where each served catalog came from, so the picker can say when it is not the agent's own. */
type SourcesByKind = Partial<Record<DriverKind, CatalogSource>>

/**
 * Names a non-`live` catalog for what it is. Only `live` is the agent's own
 * list of what it accepts; everything else is Ari's guess at it, which is
 * exactly the list that can offer a model the agent will refuse.
 */
function fallbackNote(source: CatalogSource): string | null {
  switch (source) {
    case 'live':
      return null
    case 'cache':
      return 'a cached list from the model registry'
    case 'snapshot':
      return 'a bundled list'
    case 'static':
      return 'a placeholder list'
  }
}

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
  const [detections, setDetections] = useState<ProviderReadiness[]>([])
  const [catalog, setCatalog] = useState<CatalogByKind>({})
  const [sources, setSources] = useState<SourcesByKind>({})
  const [endpointModels, setEndpointModels] = useState<SelectorOption[]>([])
  const [showLegacy, setShowLegacy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const activeId = `${listboxId}-opt-${activeIndex}`

  /** Drivers + model catalogs; cheap enough to re-run on every picker open so
   * late-landing ACP probes (which spawn the agent CLI) show up without a
   * restart. */
  const loadCatalogs = useCallback(() => {
    void Promise.allSettled([
      rpc.invoke('providers.detect').then((rows) => {
        // Stored raw: the readiness split happens in a memo, because the
        // withheld half is what the picker needs to explain an absent rail row.
        setDetections(rows)
      }),
      rpc.invoke('providers.models').then((rows) => {
        const byKind: CatalogByKind = {}
        const sources: SourcesByKind = {}
        // Every source is usable: snapshot/cache are curated to what each CLI
        // currently serves and `live` rows are the harness's own model list.
        // Which one it was is kept: only `live` is the agent's own word, and
        // the picker says so when a list came from anywhere else.
        for (const row of rows) {
          byKind[row.kind as DriverKind] = row.models
          sources[row.kind as DriverKind] = row.source
        }
        setCatalog(byKind)
        setSources(sources)
      }),
      rpc.invoke('endpoints.list').then((endpoints) => {
        // One row per model an endpoint serves, so a single endpoint holding
        // twenty models is twenty selectable entries. The id carries both
        // parts (`ep:<endpointId>:<modelId>`); model ids may contain colons,
        // and the driver splits on the first one only.
        setEndpointModels(
          endpoints.flatMap((endpoint) => {
            const models =
              Array.isArray(endpoint.models) && endpoint.models.length > 0
                ? endpoint.models
                : [{ id: endpoint.model, label: endpoint.model, contextWindow: null }]
            return models.map((model) => ({
              id: `ep:${endpoint.id}:${model.id}`,
              label: `${endpoint.name} · ${model.label}`,
              group: 'Ari Core',
              hint:
                model.contextWindow != null
                  ? `${Math.round(model.contextWindow / 1000)}k`
                  : model.id,
            }))
          }),
        )
      }),
    ]).finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    loadCatalogs()
    return rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as { type?: string }
      if (frame.type === 'catalog' || frame.type === 'detections') loadCatalogs()
    })
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
        description: model.description,
        aliases: model.aliases?.map((alias) => `${kind}:${alias}`),
        isLegacy: model.isLegacy,
      }))
    }
    return compute
  }, [catalog, endpointModels])

  const currentId = `${driverKind}:${modelId ?? ''}`
  const currentKindLabel = driverLabel(driverKind)

  const { ready, withheld } = useMemo(() => partitionProviders(detections), [detections])

  const providers = useMemo<ProviderRow[]>(
    () =>
      ready.map((detection) => {
        const kind = detection.kind as DriverKind
        return { kind, label: driverLabel(kind), count: optionsFor(kind).length }
      }),
    [ready, optionsFor],
  )

  const searching = query.trim().length > 0

  /** Every model the active provider serves, superseded ones included. */
  const allPaneModels = useMemo(
    () => (activeKind === null ? [] : optionsFor(activeKind)),
    [activeKind, optionsFor],
  )

  /**
   * Pane rows: the current models, then superseded ones once disclosed. Older
   * rows always follow the current ones, whatever order the source listed them
   * in, so the disclosure can sit between the two as their divider.
   */
  const paneModels = useMemo(() => {
    const current = allPaneModels.filter((o) => o.isLegacy !== true)
    return showLegacy ? [...current, ...allPaneModels.filter((o) => o.isLegacy === true)] : current
  }, [allPaneModels, showLegacy])

  const legacyCount = useMemo(
    () => allPaneModels.filter((o) => o.isLegacy === true).length,
    [allPaneModels],
  )

  /** Why the active pane's list is not the agent's own, when it is not. */
  const fallbackLabel = useMemo(() => {
    if (activeKind === null || activeKind === 'ari-core') return null
    const source = sources[activeKind]
    return source === undefined ? null : fallbackNote(source)
  }, [activeKind, sources])

  /** Search rows: matching models from every provider, grouped, flat order. */
  const results = useMemo<ResultGroup[]>(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const groups: ResultGroup[] = []
    let start = 0
    for (const provider of providers) {
      const options = optionsFor(provider.kind).filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          (o.hint?.toLowerCase().includes(q) ?? false) ||
          (o.description?.toLowerCase().includes(q) ?? false),
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
    // A locked session keeps its own harness even when that harness is
    // currently withheld — a mid-session logout must not silently swap the
    // pane onto a different provider's models.
    if (lockedTo !== null) return lockedTo
    if (providers.length === 0) return null
    return providers.some((p) => p.kind === driverKind) ? driverKind : (providers[0]?.kind ?? null)
  }, [providers, lockedTo, driverKind])

  useEffect(() => {
    // Each provider starts on its current models; a disclosure left open
    // across a provider switch would hide which list you are looking at.
    // The exception is a session already on an older model: folding that away
    // would open the picker with nothing checked.
    setShowLegacy(
      activeKind !== null &&
        optionsFor(activeKind).some((o) => o.isLegacy === true && matchesCurrent(o, currentId)),
    )
    // Deliberately not re-run when catalogs refresh: a late probe must not
    // fold a list the user just opened.
  }, [activeKind])

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

  const close = useCallback((): void => {
    setOpen(false)
    setQuery('')
    setActiveKind(null)
  }, [])

  /**
   * Outside pointerdown (not a fullscreen backdrop) dismisses the picker, so
   * a click on a sibling composer chip reaches that chip: the open picker
   * closes and the new one opens in the same gesture instead of the click
   * being swallowed and the composer collapsing underneath.
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current?.contains(e.target as Node) !== true) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, close])

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
    const at = Math.max(
      0,
      providers.findIndex((p) => p.kind === activeKind),
    )
    const next = providers[(at + step + providers.length) % providers.length]
    if (next !== undefined) {
      setActiveKind(next.kind)
      setQuery('')
    }
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // A focused button owns its own keys — the disclosure toggle would
    // otherwise both expand and pick the highlighted model on one Enter.
    if ((e.target as HTMLElement).tagName === 'BUTTON') return
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
      // Show "endpoint · model", not the raw `ep:<id>:<model>` handle. Sessions
      // saved before per-model selection carry a bare `ep:<id>`, which matches
      // by prefix so their label still resolves.
      const exact = endpointModels.find((e) => e.id === modelId)
      const legacy =
        exact ??
        (modelId != null ? endpointModels.find((e) => e.id.startsWith(`${modelId}:`)) : undefined)
      return legacy?.label ?? modelId ?? 'Ari Core'
    }
    const current = optionsFor(driverKind).find((o) => matchesCurrent(o, currentId))
    if (current === undefined) return modelId ?? 'CLI default'
    const { name, recommended } = splitRecommended(current.label)
    // The agent's default row says which model it resolves to; a chip reading
    // only "Default" would hide the one thing the chip is there to show.
    const resolved = current.description
    return recommended && resolved !== undefined && resolved.length <= 16
      ? `${name} · ${resolved}`
      : name
  }, [driverKind, modelId, currentId, optionsFor, endpointModels])

  const optionRow = (opt: SelectorOption, index: number) => {
    const isSelected = matchesCurrent(opt, currentId)
    const isActive = index === activeIndex
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
        className={`flex h-8 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
          isActive ? 'bg-surface-2 text-fg' : isSelected ? 'text-fg' : 'text-fg-muted'
        }`}
      >
        <span className="shrink-0 whitespace-nowrap text-[13px] font-medium">
          {splitRecommended(opt.label).name}
        </span>
        {/* The agent's own summary, only for the row in hand: a list of twelve
            taglines is noise, one beside the row being considered is an answer. */}
        <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-subtle">
          {isActive ? (opt.description ?? opt.hint) : null}
        </span>
        {isSelected ? <Check size={14} aria-hidden className="shrink-0 text-accent" /> : null}
      </button>
    )
  }

  const emptyState = (
    <p className="px-3 py-10 text-center text-xs text-fg-subtle">
      {!loaded
        ? 'Loading…'
        : providers.length === 0
          ? 'No agents ready yet.'
          : searching
            ? `No models match “${query.trim()}”.`
            : 'No models available.'}
    </p>
  )

  /** Providers that were detected but cannot run a turn, and why. */
  const withheldNote = (
    <ul className="space-y-0.5">
      {withheld.map((entry) => (
        <li key={entry.detection.kind}>
          {driverLabel(entry.detection.kind)} — {entry.reason}
        </li>
      ))}
    </ul>
  )

  const currentCount = paneModels.length - (showLegacy ? legacyCount : 0)

  /** Opens the older models, and once open marks where they begin. */
  const olderToggle =
    legacyCount > 0 ? (
      <button
        type="button"
        onClick={() => setShowLegacy((shown) => !shown)}
        aria-expanded={showLegacy}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-subtle transition-colors duration-[var(--ari-dur-fast)] hover:text-fg focus-visible:text-fg focus-visible:outline-none motion-reduce:transition-none"
      >
        {showLegacy ? 'Older models' : `${legacyCount} older`}
        <ChevronDown
          size={12}
          aria-hidden
          className={`transition-transform duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${showLegacy ? 'rotate-180' : ''}`}
        />
      </button>
    ) : null

  const noteClasses = 'border-t border-border px-3 py-2 text-[11px] leading-4 text-fg-subtle'

  return (
    <div ref={rootRef} className="relative min-w-0">
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
        className="flex h-7 w-full max-w-52 items-center gap-1.5 rounded-lg border border-border/80 bg-surface-2/60 pe-2 ps-2 text-xs font-medium text-fg-muted shadow-sm transition-all hover:border-border-strong hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
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
        <div
          role="presentation"
          onKeyDown={onMenuKeyDown}
          className="ari-pop-in absolute bottom-full left-0 z-50 mb-2 flex w-[21rem] max-w-[calc(100vw-2rem)] origin-bottom-left flex-col overflow-hidden rounded-xl border border-border bg-surface-1 shadow-[inset_0_1px_0_0_var(--ari-inner-stroke),var(--ari-shadow-3)]"
        >
          <div className="relative border-b border-border">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-fg-subtle"
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
              className="h-10 w-full bg-transparent pe-3 ps-9 text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none"
            />
          </div>
          {/* Agents run across the top as tabs: the one in view carries its
              name, the rest are their marks. Left/Right walks them. The row stays
              put during a search so the panel never resizes under the cursor. */}
          {lockedTo !== null ? (
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-fg">
              <ProviderLogo kind={lockedTo} />
              <span className="text-[13px] font-medium">{driverLabel(lockedTo)}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-fg-subtle">
                Start a new session to use another agent
              </span>
            </div>
          ) : providers.length > 0 ? (
            <div
              role="presentation"
              aria-label="Providers"
              className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-1.5"
            >
              {providers.map((provider) => {
                const isCurrent = !searching && provider.kind === activeKind
                return (
                  <button
                    key={provider.kind}
                    type="button"
                    aria-current={isCurrent}
                    title={isCurrent ? undefined : provider.label}
                    onClick={() => {
                      setActiveKind(provider.kind)
                      setQuery('')
                    }}
                    className={`flex h-7 shrink-0 items-center justify-center gap-2 rounded-md transition-colors duration-[var(--ari-dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring motion-reduce:transition-none ${
                      isCurrent
                        ? 'bg-surface-2 px-2.5 text-fg'
                        : 'w-8 text-fg-muted hover:bg-surface-2/60 hover:text-fg'
                    }`}
                  >
                    <ProviderLogo kind={provider.kind} />
                    <span className={isCurrent ? 'text-[13px] font-medium' : 'sr-only'}>
                      {provider.label}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {/* A fixed height: switching agents must not make the panel jump. */}
          <div ref={listRef} className="ari-scroll h-[15.5rem] overflow-y-auto p-1.5">
            {searching ? (
              <div id={listboxId} role="listbox" aria-label="Search results">
                {visibleCount === 0
                  ? emptyState
                  : results.map((group) => (
                      <div key={group.kind} role="presentation" className="pb-1">
                        <p className="flex h-7 items-center gap-2 px-2.5 text-xs text-fg-subtle">
                          <ProviderLogo kind={group.kind} />
                          <span>{group.label}</span>
                        </p>
                        {group.options.map((opt, i) => optionRow(opt, group.start + i))}
                      </div>
                    ))}
              </div>
            ) : (
              <>
                <div id={listboxId} role="listbox" aria-label="Models">
                  {visibleCount === 0
                    ? emptyState
                    : paneModels.map((opt, index) => (
                        <Fragment key={opt.id}>
                          {index === currentCount ? olderToggle : null}
                          {optionRow(opt, index)}
                        </Fragment>
                      ))}
                </div>
                {showLegacy ? null : olderToggle}
              </>
            )}
          </div>

          {!searching && fallbackLabel !== null && activeKind !== null ? (
            <div className={`flex items-start gap-3 ${noteClasses}`}>
              <span className="min-w-0 flex-1">
                {driverLabel(activeKind)} has not reported its own models — this is {fallbackLabel}.
                It may not accept every entry.
              </span>
              <button
                type="button"
                onClick={loadCatalogs}
                aria-label="Refresh models from the agent"
                className="shrink-0 font-medium text-fg-muted transition-colors duration-[var(--ari-dur-fast)] hover:text-fg focus-visible:text-fg focus-visible:outline-none motion-reduce:transition-none"
              >
                Refresh
              </button>
            </div>
          ) : null}

          {lockedTo === null && withheld.length > 0 ? (
            <div className={noteClasses}>
              <p className="pb-0.5 font-medium text-fg-muted">Not shown</p>
              {withheldNote}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

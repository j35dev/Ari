import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Search } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import type { CatalogModelInfo } from '@ari/contracts/rpc'
import { modelsFor } from '@ari/providers/catalogs'
import { rpc } from '../../lib/rpc'
import { agentMark, driverLabel } from './agent-mark'

export interface SelectorOption {
  id: string
  label: string
  group: string
  hint?: string
}

/** Live catalogs by kind; absent kinds fall back to the bundled snapshot. */
type CatalogByKind = Partial<Record<DriverKind, CatalogModelInfo[]>>

function AgentMark({ kind }: { kind: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-surface-3 font-mono text-2xs font-medium leading-none text-fg-muted"
    >
      {agentMark(kind)}
    </span>
  )
}

/**
 * Provider-first model picker (M23.13). Step one lists installed providers;
 * step two lists only that provider's models. Search filters the visible
 * step. Arrows move, Enter picks (or drills in on step one), Esc/Backspace
 * goes back or closes.
 */
export function ModelSelector({
  driverKind,
  modelId,
  onChange,
}: {
  driverKind: DriverKind
  modelId: string | null
  onChange: (next: { driverKind: DriverKind; modelId: string | null }) => void
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

  useEffect(() => {
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

  /** Models for one provider — the step-two list. */
  const optionsFor = useMemo(() => {
    const compute = (kind: DriverKind): SelectorOption[] => {
      if (kind === 'ari-core') return endpointModels
      return (catalog[kind] ?? modelsFor(kind)).map((model) => ({
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

  /** Step-one rows: one per installed provider, showing its active model. */
  const providers = useMemo(
    () =>
      drivers.map((driver) => {
        const opts = optionsFor(driver.kind)
        const active = opts.find((o) => o.id === `${driver.kind}:${driver.kind === driverKind ? (modelId ?? '') : ''}`)
        return {
          kind: driver.kind,
          label: driver.label,
          // Only the CURRENT provider's active model is knowable; others show
          // their model count so the step doesn't look empty.
          detail: driver.kind === driverKind ? (active?.label ?? modelId ?? 'CLI default') : `${opts.length} models`,
        }
      }),
    [drivers, optionsFor, driverKind, modelId],
  )

  /** Step-two rows: the active provider's models, filtered by query. */
  const models = useMemo(() => {
    if (activeKind === null) return []
    const q = query.trim().toLowerCase()
    const list = optionsFor(activeKind)
    if (q.length === 0) return list
    return list.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false),
    )
  }, [activeKind, optionsFor, query])

  const visibleCount = activeKind === null ? providers.length : models.length

  const filteredRef = useRef(visibleCount)
  filteredRef.current = visibleCount
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const activeKindRef = useRef(activeKind)
  activeKindRef.current = activeKind

  useEffect(() => {
    if (!open) return
    setActiveIndex(0)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, query, activeKind])

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
    const [kind, ...rest] = opt.id.split(':')
    onChange({ driverKind: kind as DriverKind, modelId: rest.join(':') || null })
    close()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (activeKind !== null) {
        setActiveKind(null)
        setQuery('')
      } else {
        close()
      }
      return
    }
    if (e.key === 'Backspace' && query.length === 0 && activeKind !== null) {
      e.preventDefault()
      setActiveKind(null)
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
      if (activeKind === null) {
        const provider = providers[activeIndex]
        if (provider !== undefined) {
          setActiveKind(provider.kind)
          setQuery('')
        }
        return
      }
      const opt = models[activeIndex]
      if (opt !== undefined) pickModel(opt)
    }
  }

  const triggerLabel = useMemo(() => {
    if (driverKind === 'ari-core') return modelId ?? 'Ari Core'
    const list = optionsFor(driverKind)
    return list.find((o) => o.id === currentId)?.label ?? modelId ?? 'CLI default'
  }, [driverKind, modelId, currentId, optionsFor])

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={`Model: ${currentKindLabel} · ${triggerLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-border bg-surface-1 pe-2 ps-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <AgentMark kind={driverKind} />
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
            className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-lg border border-border shadow-2"
          >
            {activeKind !== null && (
              <button
                type="button"
                onClick={() => {
                  setActiveKind(null)
                  setQuery('')
                }}
                className="flex w-full items-center gap-1.5 border-b border-border px-2 py-1.5 text-start text-xs text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg"
              >
                <ArrowLeft size={12} aria-hidden className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{driverLabel(activeKind)}</span>
              </button>
            )}
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
                placeholder={activeKind === null ? 'Search providers…' : 'Search models…'}
                aria-label={activeKind === null ? 'Search providers' : 'Search models'}
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
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={activeKind === null ? 'Providers' : 'Models'}
              className="ari-scroll max-h-72 overflow-y-auto p-1"
            >
              {visibleCount === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-fg-subtle">
                  {!loaded
                    ? 'Loading…'
                    : drivers.length === 0
                      ? 'No agents detected yet.'
                      : activeKind !== null
                        ? `No models match “${query.trim()}”.`
                        : 'No providers match.'}
                </p>
              ) : activeKind === null ? (
                providers.map((provider, index) => {
                  const isActive = index === activeIndex
                  const isCurrentProvider = provider.kind === driverKind
                  return (
                    <button
                      key={provider.kind}
                      id={`${listboxId}-opt-${index}`}
                      type="button"
                      role="option"
                      aria-selected={isCurrentProvider}
                      data-option-index={index}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        setActiveKind(provider.kind)
                        setQuery('')
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
                        isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted'
                      }`}
                    >
                      <AgentMark kind={provider.kind} />
                      <span className="min-w-0 flex-1 truncate text-xs">{provider.label}</span>
                      <span className="shrink-0 font-mono text-2xs text-fg-subtle">{provider.detail}</span>
                      {isCurrentProvider ? (
                        <Check size={12} className="shrink-0 text-fg" aria-hidden />
                      ) : null}
                    </button>
                  )
                })
              ) : (
                models.map((opt, index) => {
                  const isActive = index === activeIndex
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
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
                        isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs">{opt.label}</span>
                      {opt.hint ? (
                        <span className="shrink-0 font-mono text-2xs text-fg-subtle">{opt.hint}</span>
                      ) : null}
                      {isSelected ? <Check size={12} className="shrink-0 text-fg" aria-hidden /> : null}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronUp, Search } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import type { CatalogModelInfo } from '@ari/contracts/rpc'
import { modelsFor } from '@ari/providers/catalogs'
import { rpc } from '../../lib/rpc'

export interface SelectorOption {
  id: string
  label: string
  group: string
}

/** Live catalogs by kind; absent kinds fall back to the bundled snapshot. */
type CatalogByKind = Partial<Record<DriverKind, CatalogModelInfo[]>>

/** Provider label shown in the pill; short and uppercase like a chip. */
function providerChipLabel(group: string): string {
  return group === 'Ari Core' ? 'core' : group.slice(0, 8).toLowerCase()
}

/**
 * Prompt-box model picker (T3 ProviderModelPicker parity): the pill shows
 * provider + model; the popover is a searchable, grouped list with keyboard
 * navigation (↑↓ move · Enter select · Esc close).
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
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [drivers, setDrivers] = useState<{ kind: DriverKind; label: string }[]>([])
  const [catalog, setCatalog] = useState<CatalogByKind>({})
  const [endpointModels, setEndpointModels] = useState<SelectorOption[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        setDrivers(
          detections
            .filter((d) => d.binaryPath !== null || d.kind === 'ari-core')
            .map((d) => ({
              kind: d.kind as DriverKind,
              label: d.kind === 'ari-core' ? 'Ari Core' : d.kind,
            })),
        )
      })
      .catch(() => undefined)
    void rpc
      .invoke('providers.models')
      .then((rows) => {
        const byKind: CatalogByKind = {}
        for (const row of rows) byKind[row.kind as DriverKind] = row.models
        setCatalog(byKind)
      })
      .catch(() => undefined)
    void rpc
      .invoke('endpoints.list')
      .then((endpoints) => {
        setEndpointModels(
          endpoints.map((e) => ({ id: `ep:${e.id}`, label: e.name, group: 'Ari Core' })),
        )
      })
      .catch(() => undefined)
  }, [])

  const options = useMemo<SelectorOption[]>(() => {
    const out: SelectorOption[] = []
    for (const driver of drivers) {
      if (driver.kind === 'ari-core') {
        out.push(...endpointModels)
        continue
      }
      for (const model of catalog[driver.kind] ?? modelsFor(driver.kind)) {
        out.push({ id: `${driver.kind}:${model.id}`, label: model.label, group: driver.label })
      }
    }
    return out
  }, [drivers, endpointModels, catalog])

  const currentId = `${driverKind}:${modelId ?? ''}`
  const current = options.find((o) => o.id === currentId)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.group.toLowerCase().includes(q),
    )
  }, [options, query])

  // Grouped view preserves first-seen provider order.
  const grouped = useMemo(() => {
    const groups: { group: string; options: SelectorOption[] }[] = []
    const byGroup = new Map<string, SelectorOption[]>()
    for (const opt of filtered) {
      let list = byGroup.get(opt.group)
      if (list === undefined) {
        list = []
        byGroup.set(opt.group, list)
        groups.push({ group: opt.group, options: list })
      }
      list.push(opt)
    }
    return groups
  }, [filtered])

  useEffect(() => {
    if (open) setActiveIndex(0)
  }, [open, query])

  // Keep the active option visible while arrowing through the list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const pick = (opt: SelectorOption): void => {
    const [kind, ...rest] = opt.id.split(':')
    onChange({ driverKind: kind as DriverKind, modelId: rest.join(':') || null })
    setOpen(false)
    setQuery('')
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt !== undefined) pick(opt)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Model selector"
        aria-expanded={open}
        className="flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface-1 pl-1.5 pr-2.5 text-xs transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span
          aria-hidden
          className="rounded-sm bg-surface-3 px-1 py-px font-mono text-2xs uppercase tracking-wide text-fg-subtle"
        >
          {providerChipLabel(current?.group ?? driverKind)}
        </span>
        <span className="max-w-36 truncate text-fg-muted">
          {current?.label ?? (modelId ?? driverKind)}
        </span>
        <ChevronUp size={11} className={`text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-label="Models"
            tabIndex={0}
            autoFocus
            onKeyDown={onMenuKeyDown}
            className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-lg border border-border shadow-2 focus:outline-none"
          >
            <div className="relative border-b border-border">
              <Search
                size={12}
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                aria-label="Search models"
                className="h-8 w-full bg-transparent pl-7 pr-2 text-xs text-fg placeholder:text-fg-subtle focus:outline-none"
              />
            </div>
            <div ref={listRef} className="ari-scroll max-h-72 overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-fg-subtle">
                  No models match “{query.trim()}”.
                </p>
              ) : (
                grouped.map(({ group, options: groupOptions }) => (
                  <div key={group}>
                    <p className="px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                      {group}
                    </p>
                    {groupOptions.map((opt) => {
                      const flatIndex = filtered.indexOf(opt)
                      const isActive = flatIndex === activeIndex
                      const isSelected = opt.id === currentId
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-option-index={flatIndex}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                          onClick={() => pick(opt)}
                          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors ${
                            isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted'
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate text-xs">{opt.label}</span>
                          {isSelected ? (
                            <Check size={12} className="shrink-0 text-accent" aria-hidden />
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

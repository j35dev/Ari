import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import type { CatalogModelInfo } from '@ari/contracts/rpc'
import { modelsFor } from '@ari/providers/catalogs'
import { rpc } from '../../lib/rpc'
import { agentMark, driverLabel, kindFromGroup } from './agent-mark'

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
 * Agent-first model picker. The trigger is a letter mark plus the model name;
 * the menu is a searchable, grouped combobox (arrows move, Enter picks, Esc
 * closes). Search stays focused so typing filters without a separate mode.
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

  const options = useMemo<SelectorOption[]>(() => {
    const out: SelectorOption[] = []
    for (const driver of drivers) {
      if (driver.kind === 'ari-core') {
        out.push(...endpointModels)
        continue
      }
      for (const model of catalog[driver.kind] ?? modelsFor(driver.kind)) {
        out.push({
          id: `${driver.kind}:${model.id}`,
          label: model.label,
          group: driver.label,
          hint: model.contextHint,
        })
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
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.group.toLowerCase().includes(q) ||
        (o.hint?.toLowerCase().includes(q) ?? false),
    )
  }, [options, query])

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

  const filteredRef = useRef(filtered)
  filteredRef.current = filtered
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

  useEffect(() => {
    if (!open) return
    const list = filteredRef.current
    const selected = list.findIndex((o) => o.id === currentIdRef.current)
    setActiveIndex(selected >= 0 ? selected : 0)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, query])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  const pick = (opt: SelectorOption): void => {
    const [kind, ...rest] = opt.id.split(':')
    onChange({ driverKind: kind as DriverKind, modelId: rest.join(':') || null })
    close()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(Math.max(filtered.length - 1, 0), i + 1))
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
      setActiveIndex(Math.max(filtered.length - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt !== undefined) pick(opt)
    }
  }

  const triggerKind = current ? kindFromGroup(current.group) : driverKind
  const triggerLabel = current?.label ?? modelId ?? driverLabel(driverKind)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={`Model: ${driverLabel(triggerKind)} · ${triggerLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 max-w-52 items-center gap-1.5 rounded-md border border-border bg-surface-1 pe-2 ps-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <AgentMark kind={triggerKind} />
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
            className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-lg border border-border shadow-2"
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
                placeholder="Search agents or models…"
                aria-label="Search models"
                aria-controls={listboxId}
                aria-activedescendant={filtered.length > 0 ? activeId : undefined}
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
              aria-label="Models"
              className="ari-scroll max-h-72 overflow-y-auto p-1"
            >
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-fg-subtle">
                  {!loaded
                    ? 'Loading models…'
                    : options.length === 0
                      ? 'No agents detected yet.'
                      : `No models match “${query.trim()}”.`}
                </p>
              ) : (
                grouped.map(({ group, options: groupOptions }) => (
                  <div key={group} role="group" aria-label={group}>
                    <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-2xs font-medium text-fg-subtle">
                      <AgentMark kind={kindFromGroup(group)} />
                      {group}
                    </p>
                    {groupOptions.map((opt) => {
                      const flatIndex = filtered.indexOf(opt)
                      const isActive = flatIndex === activeIndex
                      const isSelected = opt.id === currentId
                      return (
                        <button
                          key={opt.id}
                          id={`${listboxId}-opt-${flatIndex}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-option-index={flatIndex}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                          onClick={() => pick(opt)}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
                            isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted'
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate text-xs">{opt.label}</span>
                          {opt.hint ? (
                            <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                              {opt.hint}
                            </span>
                          ) : null}
                          {isSelected ? (
                            <Check size={12} className="shrink-0 text-fg" aria-hidden />
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

import { useEffect, useMemo, useState } from 'react'
import { ChevronUp } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import { modelsFor } from '@ari/providers/catalogs'
import { rpc } from '../../lib/rpc'

export interface SelectorOption {
  id: string
  label: string
  group: string
}

/**
 * Prompt-box model pill: shows the active driver·model and opens a grouped
 * picker of detected drivers, their catalog models, and Ari Core endpoints.
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
  const [drivers, setDrivers] = useState<{ kind: DriverKind; label: string }[]>([])
  const [endpointModels, setEndpointModels] = useState<SelectorOption[]>([])

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
      for (const model of modelsFor(driver.kind)) {
        out.push({ id: `${driver.kind}:${model.id}`, label: model.label, group: driver.label })
      }
    }
    return out
  }, [drivers, endpointModels])

  const current = options.find((o) => o.id === `${driverKind}:${modelId ?? ''}`)
  const display = current?.label ?? (modelId ? modelId : driverKind)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span className="max-w-40 truncate">{display}</span>
        <ChevronUp size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-64 overflow-y-auto rounded-md border border-border bg-surface-1 p-1 shadow-2 ari-scroll">
            {options.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-fg-subtle">No models available</p>
            ) : (
              options.map((opt) => {
                const isActive = opt.id === `${driverKind}:${modelId ?? ''}`
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      const [kind, ...rest] = opt.id.split(':')
                      onChange({
                        driverKind: kind as DriverKind,
                        modelId: rest.join(':') || null,
                      })
                      setOpen(false)
                    }}
                    className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left transition-colors ${
                      isActive ? 'bg-accent-subtle text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                    }`}
                  >
                    <span className="truncate text-xs">{opt.label}</span>
                    <span className="ml-2 shrink-0 text-2xs uppercase tracking-wide text-fg-subtle">
                      {opt.group}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

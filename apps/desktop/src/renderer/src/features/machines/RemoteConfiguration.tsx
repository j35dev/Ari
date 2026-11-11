import { useEffect, useState } from 'react'
import { permissionModeSchema, type DriverKind, type PermissionMode } from '@ari/contracts/common'
import {
  remoteEffortOptionSchema,
  remoteModelCatalogSchema,
  type RemoteModelCatalog,
  type RemoteEffortOption,
} from '@ari/contracts/remote'
import { z } from 'zod'
import type { MachineView } from '@ari/contracts/machines'
import { remoteQuery } from './remote-client'
import { machineCan } from './use-machines'

export interface RemoteSelection {
  driverKind: DriverKind
  modelId: string
  permissionMode: PermissionMode
  effort: string | null
}
export const SELECT_CLASS =
  'mt-1 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm text-fg focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50'

const catalogCache = new Map<string, RemoteModelCatalog>()
export function useRemoteCatalog(machine: MachineView) {
  const [catalog, setCatalog] = useState<RemoteModelCatalog | null>(
    () => catalogCache.get(machine.id) ?? null,
  )
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (machineCan(machine, 'models.list'))
      void remoteQuery(machine.id, { op: 'models.list' })
        .then((result) => {
          if (alive) {
            const next = remoteModelCatalogSchema.parse(result)
            catalogCache.set(machine.id, next)
            setCatalog(next)
            setError(null)
          }
        })
        .catch((error: unknown) => {
          if (alive)
            setError(error instanceof Error ? error.message : 'Could not read host providers.')
        })
    return () => {
      alive = false
    }
  }, [machine.id, machine.status])
  return { catalog, error }
}

export function RemoteConfiguration({
  machine,
  catalog,
  value,
  onChange,
  disabled,
  fixedProvider = false,
}: {
  machine: MachineView
  catalog: RemoteModelCatalog
  value: RemoteSelection
  onChange: (selection: RemoteSelection) => void
  disabled?: boolean
  fixedProvider?: boolean
}) {
  const provider = catalog.providers.find((row) => row.driverKind === value.driverKind)
  const model = provider?.models.find((row) => row.id === value.modelId)
  const [liveEfforts, setLiveEfforts] = useState<RemoteEffortOption[] | null>(null)
  useEffect(() => {
    let alive = true
    setLiveEfforts(null)
    if (machineCan(machine, 'models.efforts'))
      void remoteQuery(machine.id, {
        op: 'models.efforts',
        driverKind: value.driverKind,
        modelId: value.modelId || null,
      })
        .then((result) => {
          if (alive)
            setLiveEfforts(
              z.object({ efforts: remoteEffortOptionSchema.array() }).parse(result).efforts,
            )
        })
        .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [machine.id, machine.status, value.driverKind, value.modelId])
  const efforts = liveEfforts ?? model?.efforts ?? provider?.efforts ?? []
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="text-xs text-fg-muted">
        Host provider
        <select
          className={SELECT_CLASS}
          value={value.driverKind}
          disabled={disabled || fixedProvider}
          onChange={(event) => {
            const next = catalog.providers.find((row) => row.driverKind === event.target.value)
            if (next)
              onChange({
                ...value,
                driverKind: next.driverKind,
                modelId: next.defaultModelId ?? next.models[0]?.id ?? '',
                effort: null,
              })
          }}
        >
          {catalog.providers.map((row) => (
            <option key={row.driverKind} value={row.driverKind} disabled={row.available !== true}>
              {row.driverKind}
              {row.available !== true ? ' (unavailable)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-fg-muted">
        Host model
        <select
          className={SELECT_CLASS}
          value={value.modelId}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, modelId: event.target.value, effort: null })}
        >
          <option value="">Provider default</option>
          {provider?.models.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-fg-muted">
        Permissions
        <select
          className={SELECT_CLASS}
          value={value.permissionMode}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, permissionMode: permissionModeSchema.parse(event.target.value) })
          }
        >
          {provider?.modes?.length ? (
            provider.modes.map((mode) => (
              <option key={mode.id} value={mode.ariMode}>
                {mode.label}
              </option>
            ))
          ) : (
            <>
              <option value="ask">Ask</option>
              <option value="allow-edits">Allow edits</option>
              <option value="full">Full access</option>
            </>
          )}
        </select>
      </label>
      <label className="text-xs text-fg-muted">
        Reasoning effort
        <select
          className={SELECT_CLASS}
          value={value.effort ?? ''}
          disabled={disabled || efforts.length === 0}
          onChange={(event) => onChange({ ...value, effort: event.target.value || null })}
        >
          <option value="">Provider default</option>
          {efforts.map((effort) => (
            <option key={effort.id} value={effort.id}>
              {effort.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

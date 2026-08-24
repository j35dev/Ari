import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { CatalogModelInfo, RpcResults } from '@ari/contracts/rpc'
import { modelsFor } from '@ari/providers/catalogs'
import { Button } from '@ari/ui/button'
import { Field } from '@ari/ui/field'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import type { SelectOption } from '@ari/ui/select'
import { SegmentedControl } from '@ari/ui/segmented-control'
import { rpc } from '../../lib/rpc'

type Detection = RpcResults['providers.detect'][number]
type EndpointRow = RpcResults['endpoints.list'][number]
/** Live catalogs by kind; absent kinds fall back to the bundled snapshot. */
type CatalogByKind = Partial<Record<DriverKind, CatalogModelInfo[]>>

interface NewSessionPanelProps {
  /** Called with the new session id once the engine accepts session.create. */
  onSuccess: (sessionId: string) => void
  /** Called when the user dismisses the canvas without creating. */
  onCancel: () => void
}

const DRIVER_KIND_SET: ReadonlySet<string> = new Set<DriverKind>([
  'claude',
  'codex',
  'opencode',
  'grok',
  'pi',
  'hermes',
  'ari-core',
])

const PERMISSION_MODES: PermissionMode[] = ['ask', 'allow-edits', 'full']

const PERMISSION_OPTIONS = [
  { value: 'ask', label: 'Ask' },
  { value: 'allow-edits', label: 'Allow edits' },
  { value: 'full', label: 'Full' },
]

function driverLabel(kind: DriverKind): string {
  return kind === 'ari-core' ? 'Ari Core (built-in)' : kind.charAt(0).toUpperCase() + kind.slice(1)
}

function parseDriverKind(value: string): DriverKind | null {
  return DRIVER_KIND_SET.has(value) ? (value as DriverKind) : null
}

function parsePermissionMode(value: string): PermissionMode | null {
  return PERMISSION_MODES.includes(value as PermissionMode) ? (value as PermissionMode) : null
}

/**
 * New-session canvas: driver picker fed by `providers.detect` (plus Ari Core,
 * which never needs a binary), model picker fed by the static catalogs or —
 * for ari-core — by the user's configured endpoints; permission mode and
 * title round out the `session.create` payload.
 */
export function NewSessionPanel({ onSuccess, onCancel }: NewSessionPanelProps): ReactNode {
  const [drivers, setDrivers] = useState<DriverKind[]>([])
  const [driverKind, setDriverKind] = useState<DriverKind | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogByKind>({})
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([])
  const [title, setTitle] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('providers.detect')
      .then((detections: Detection[]) => {
        if (cancelled) return
        const usable = detections.filter(
          (detection) => detection.binaryPath != null && DRIVER_KIND_SET.has(detection.kind),
        )
        setDrivers(usable.map((detection) => detection.kind as DriverKind))
        setDriverKind((usable[0]?.kind as DriverKind | undefined) ?? 'ari-core')
      })
      .catch(() => {
        // Detection is best-effort; Ari Core works without any installed CLI.
        if (!cancelled) setDriverKind('ari-core')
      })
    void rpc
      .invoke('providers.models')
      .then((rows) => {
        if (cancelled) return
        const byKind: CatalogByKind = {}
        for (const row of rows) {
          if (row.source === 'live') byKind[row.kind as DriverKind] = row.models
        }
        setCatalog(byKind)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (driverKind === null || driverKind === 'ari-core') return
    const models = catalog[driverKind] ?? modelsFor(driverKind)
    setModelId(models[0]?.id ?? null)
  }, [driverKind, catalog])

  useEffect(() => {
    if (driverKind !== 'ari-core') {
      setEndpoints([])
      return
    }
    let cancelled = false
    void rpc
      .invoke('endpoints.list')
      .then((rows: EndpointRow[]) => {
        if (!cancelled) setEndpoints(rows)
      })
      .catch(() => {
        if (!cancelled) setEndpoints([])
      })
    return () => {
      cancelled = true
    }
  }, [driverKind])

  const driverOptions = [...drivers, 'ari-core' as const].map((kind) => ({
    value: kind,
    label: driverLabel(kind),
  }))

  const modelOptions: SelectOption[] = []
  if (driverKind === 'ari-core') {
    for (const endpoint of endpoints) {
      modelOptions.push({ value: endpoint.id, label: endpoint.name })
    }
  } else if (driverKind !== null) {
    for (const model of catalog[driverKind] ?? modelsFor(driverKind)) {
      modelOptions.push({
        value: model.id,
        label: model.contextHint != null ? `${model.label} · ${model.contextHint}` : model.label,
      })
    }
  }

  const modelDisabled = driverKind === null || (driverKind === 'ari-core' && endpoints.length === 0)

  const handleDriverChange = (value: string) => {
    const next = parseDriverKind(value)
    if (next == null) return
    setModelId(null)
    setDriverKind(next)
  }

  const handleCreate = () => {
    if (driverKind === null || creating) return
    setCreating(true)
    setError(null)
    void rpc
      .invoke('session.create', {
        projectId: 'adhoc',
        title: title.trim(),
        driverKind,
        modelId,
        permissionMode,
      })
      .then((result) => {
        onSuccess(result.sessionId)
      })
      .catch(() => {
        setError('Session creation failed. Try again.')
        setCreating(false)
      })
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <section
        aria-label="New session"
        className="w-[min(480px,90vw)] space-y-4 rounded-lg border border-border bg-surface-1 p-5"
      >
        <h2 className="text-sm font-medium text-fg">New session</h2>
        <Field label="Driver">
          {() => (
            <Select
              value={driverKind ?? undefined}
              onValueChange={handleDriverChange}
              options={driverOptions}
              placeholder="Choose driver"
              disabled={driverKind === null}
            />
          )}
        </Field>
        <Field label="Model">
          {() => (
            <Select
              value={modelId ?? undefined}
              onValueChange={(value) => {
                setModelId(value)
              }}
              options={modelOptions}
              placeholder={
                driverKind === 'ari-core' && endpoints.length === 0
                  ? 'No endpoints configured'
                  : 'Choose model'
              }
              disabled={modelDisabled}
            />
          )}
        </Field>
        <Field label="Permission mode">
          {() => (
            <SegmentedControl
              value={permissionMode}
              onChange={(value) => {
                const next = parsePermissionMode(value)
                if (next != null) setPermissionMode(next)
              }}
              options={PERMISSION_OPTIONS}
              size="sm"
            />
          )}
        </Field>
        <Field label="Title" hint="Optional — shown in the sessions sidebar.">
          {(controlProps) => (
            <Input
              {...controlProps}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Fix the flaky auth test"
              autoComplete="off"
            />
          )}
        </Field>
        {error != null && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
          <Button variant="primary" loading={creating} onClick={() => void handleCreate()}>
            Create
          </Button>
        </div>
      </section>
    </div>
  )
}

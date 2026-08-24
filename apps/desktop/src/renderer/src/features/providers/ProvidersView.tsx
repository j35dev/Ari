import { useCallback, useEffect, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import type { BadgeTone } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Spinner } from '@ari/ui/spinner'
import { Tooltip } from '@ari/ui/tooltip'
import { RefreshCw } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { useProviderInstalls } from './use-provider-installs'

type Detection = RpcResults['providers.detect'][number]

const AUTH_BADGES: Record<string, { label: string; tone: BadgeTone }> = {
  authenticated: { label: 'authenticated', tone: 'success' },
  unauthenticated: { label: 'unauthenticated', tone: 'warning' },
  unknown: { label: 'unknown', tone: 'neutral' },
}

const UNKNOWN_AUTH_TOOLTIP = 'Ari could not verify - the CLI manages its own login'

const UNKNOWN_AUTH_BADGE: { label: string; tone: BadgeTone } = {
  label: 'unknown',
  tone: 'neutral',
}

function authBadgeFor(authStatus: string): { label: string; tone: BadgeTone } {
  return AUTH_BADGES[authStatus] ?? UNKNOWN_AUTH_BADGE
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

interface PendingAction {
  kind: DriverKind
  operation: 'install' | 'upgrade'
  display: string
}

interface ProviderCardProps {
  detection: Detection
  running: ReturnType<typeof useProviderInstalls>['installs'][DriverKind]
  onInstall: (detection: Detection) => void
  onUpdate: (detection: Detection) => void
  onCancel: (kind: DriverKind) => void
}

function ProviderCard({ detection, running, onInstall, onUpdate, onCancel }: ProviderCardProps) {
  const isCore = detection.kind === 'ari-core'
  const auth = authBadgeFor(isCore ? 'authenticated' : detection.authStatus)
  const badge = <Badge tone={auth.tone}>{auth.label}</Badge>
  const isRunning = running != null && running.outcome === null

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-sm font-medium text-fg">
          {isCore ? 'Ari Core (built-in)' : capitalize(detection.kind)}
        </span>
        {detection.authStatus === 'unknown' && !isCore ? (
          <Tooltip content={UNKNOWN_AUTH_TOOLTIP}>{badge}</Tooltip>
        ) : (
          badge
        )}
      </div>

      {isRunning ? (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner className="h-3 w-3" />
          {running?.operation === 'install' ? 'Installing…' : 'Updating…'}
        </p>
      ) : detection.binaryPath === null && !isCore ? (
        <p className="text-2xs text-danger">not installed</p>
      ) : detection.version != null ? (
        <p className="truncate font-mono text-2xs text-fg-subtle">{detection.version}</p>
      ) : null}

      {detection.binaryPath != null && (
        <p className="truncate font-mono text-2xs text-fg-subtle" title={detection.binaryPath}>
          {detection.binaryPath}
        </p>
      )}

      {detection.updateAvailable === true && !isRunning && !isCore && (
        <p className="text-2xs text-warning">update available{detection.latestVersion != null ? ` → ${detection.latestVersion}` : ''}</p>
      )}

      {!isCore && (
        <div className="flex items-center gap-2">
          {detection.installed ? (
            <>
              {detection.updateAvailable === true && (
                <Button size="sm" onClick={() => onUpdate(detection)}>Update</Button>
              )}
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => onInstall(detection)}>
              Install
            </Button>
          )}
          {isRunning ? (
            <Button size="sm" variant="ghost" onClick={() => onCancel(detection.kind as DriverKind)}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onUpdate(detection)} disabled={detection.binaryPath === null}>
              Re-check
            </Button>
          )}
        </div>
      )}

      {isCore && (
        <p className="text-xs text-fg-muted">
          Runs on your own endpoints — manage them in the Endpoints section below.
        </p>
      )}

      {running != null && running.lines.length > 0 && (
        <pre
          role="log"
          aria-label={`${capitalize(detection.kind)} command output`}
          className="max-h-32 overflow-y-auto rounded bg-surface-0 p-2 font-mono text-2xs leading-4 text-fg-subtle"
        >
          {running.lines.map((line, index) => (
            // Output lines have no stable id; position is their identity.
            <span key={index} className="block whitespace-pre-wrap break-all">
              {line.text}
            </span>
          ))}
        </pre>
      )}

      {running?.outcome != null && !running.outcome.ok && (
        <p role="alert" className="text-xs text-danger">
          {running.outcome.reason}
        </p>
      )}
    </li>
  )
}

/**
 * Providers settings page (M12.2 / M23.2): detection grid with per-CLI
 * version, install state and auth badges; one-click install/update behind a
 * confirm dialog that shows the literal command before anything runs.
 */
export function ProvidersView() {
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const { installs, planFor, start, cancel } = useProviderInstalls(setDetections)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    try {
      setDetections(await rpc.invoke('providers.detect'))
      setError(null)
    } catch {
      setError('Provider detection failed.')
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  /** Fetches the plan first so the dialog can show the literal command. */
  const beginAction = async (detection: Detection, operation: 'install' | 'upgrade'): Promise<void> => {
    try {
      const plan = await planFor(detection.kind as DriverKind)
      if (plan === null) {
        setError(`No known install channel for ${capitalize(detection.kind)}. Install it manually and re-scan.`)
        return
      }
      setPending({
        kind: detection.kind as DriverKind,
        operation,
        // For an update of an installed CLI the upgrade command is the honest
        // preview; for a fresh install show the install command instead.
        display: (operation === 'install' ? plan.installCommand : plan.upgradeCommand).join(' '),
      })
      setError(null)
    } catch {
      setError('Could not plan the operation.')
    }
  }

  return (
    <section aria-label="Providers" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-fg">Providers</h2>
        <Button size="sm" variant="secondary" disabled={scanning} onClick={() => void scan()}>
          <RefreshCw className={`h-3.5 w-3.5${scanning ? ' animate-spin' : ''}`} /> Re-scan
        </Button>
      </div>

      {error != null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {detections === null ? null : detections.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">
          No providers detected.
          <br />
          Install a supported CLI and re-scan.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {detections.map((detection) => (
            <ProviderCard
              key={detection.kind}
              detection={detection}
              running={installs[detection.kind as DriverKind]}
              onInstall={(d) => void beginAction(d, 'install')}
              onUpdate={(d) => void beginAction(d, d.installed && d.updateAvailable === true ? 'upgrade' : 'install')}
              onCancel={(kind) => void cancel(kind)}
            />
          ))}
        </ul>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        {pending !== null && (
          <DialogContent pending={pending} onConfirm={() => {
            void start(pending.kind, pending.operation)
            setPending(null)
          }} />
        )}
      </Dialog>
    </section>
  )
}

function DialogContent({ pending, onConfirm }: { pending: PendingAction; onConfirm: () => void }) {
  return (
    <Dialog.Content size="md">
      <Dialog.Title>
        {pending.operation === 'install' ? 'Install provider' : 'Update provider'}
      </Dialog.Title>
      <Dialog.Description>
        Ari will run this exact command. Nothing runs until you confirm.
      </Dialog.Description>
      <pre
        aria-label="Command to run"
        className="overflow-x-auto rounded bg-surface-0 p-2 font-mono text-xs text-fg"
      >
        {pending.display}
      </pre>
      <div className="mt-3 flex justify-end gap-2">
        <Dialog.Close>
          <Button size="sm" variant="ghost">Cancel</Button>
        </Dialog.Close>
        <Button size="sm" onClick={onConfirm}>
          Run command
        </Button>
      </div>
    </Dialog.Content>
  )
}
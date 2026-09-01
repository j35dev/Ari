import { useCallback, useEffect, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import type { BadgeTone } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { Tooltip } from '@ari/ui/tooltip'
import { RefreshCw } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { ProviderSignIn } from './ProviderSignIn'
import { useProviderAuth } from './use-provider-auth'
import type { ProviderAuthEntry } from './use-provider-auth'
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

/**
 * The badge the user should believe. The detector infers a verdict from a
 * credential file existing, which can read `authenticated` while every turn is
 * refused; a live wall or a preflight is direct evidence and overrides it.
 */
function resolveAuthBadge(
  detection: Detection,
  observed: ProviderAuthEntry | undefined,
): { label: string; tone: BadgeTone } {
  if (observed?.result.status === 'auth-required') {
    return { label: 'sign-in needed', tone: 'warning' }
  }
  if (observed?.result.status === 'ready') return AUTH_BADGES['authenticated'] as { label: string; tone: BadgeTone }
  return authBadgeFor(detection.authStatus)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

interface ProviderCardProps {
  detection: Detection
  running: ReturnType<typeof useProviderInstalls>['installs'][DriverKind]
  auth: ProviderAuthEntry | undefined
  checkingAuth: boolean
  onInstall: (detection: Detection) => void
  onUpdate: (detection: Detection) => void
  onRecheck: () => void
  onCheckAuth: (kind: DriverKind) => void
  onAuthResolved: (kind: DriverKind) => void
  onCancel: (kind: DriverKind) => void
  onOpenTerminal?: () => void
}

function ProviderCard({
  detection,
  running,
  auth,
  checkingAuth,
  onInstall,
  onUpdate,
  onRecheck,
  onCheckAuth,
  onAuthResolved,
  onCancel,
  onOpenTerminal,
}: ProviderCardProps) {
  const isCore = detection.kind === 'ari-core'
  const authBadge = isCore
    ? authBadgeFor('authenticated')
    : resolveAuthBadge(detection, auth)
  const badge = <Badge tone={authBadge.tone}>{authBadge.label}</Badge>
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
        <p className="text-2xs text-warning">
          update available{detection.latestVersion != null ? ` → ${detection.latestVersion}` : ''}
        </p>
      )}
      {detection.installed && detection.updateAvailable === false && !isRunning && !isCore && (
        <p className="text-2xs text-fg-subtle">Up to date.</p>
      )}

      {/* The detector's own explanation, which used to be computed and never shown. */}
      {!isCore && detection.authStatus === 'unknown' && detection.authReason != null && auth == null && (
        <p className="text-2xs text-fg-subtle">{detection.authReason}</p>
      )}

      {!isCore && auth != null && (
        <ProviderSignIn
          kind={detection.kind as DriverKind}
          result={auth.result}
          onOpenTerminal={onOpenTerminal}
          onDone={() => onAuthResolved(detection.kind as DriverKind)}
        />
      )}

      {!isCore && (
        <div className="flex items-center gap-2">
          {detection.installed ? (
            <>
              {detection.updateAvailable === true && (
                <Button size="sm" onClick={() => onUpdate(detection)} disabled={isRunning}>
                  Update
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onInstall(detection)}
              disabled={isRunning}
            >
              Install
            </Button>
          )}
          {isRunning ? (
            <Button size="sm" variant="ghost" onClick={() => onCancel(detection.kind as DriverKind)}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onRecheck} disabled={detection.binaryPath === null}>
              Re-check
            </Button>
          )}
          {detection.installed && !isRunning && (
            <Button
              size="sm"
              variant="ghost"
              disabled={checkingAuth}
              onClick={() => onCheckAuth(detection.kind as DriverKind)}
            >
              {checkingAuth ? <Spinner className="h-3 w-3" /> : null} Check sign-in
            </Button>
          )}
        </div>
      )}

      {isCore && (
        <p className="text-xs text-fg-muted">
          Runs on your own endpoints — manage them in the Endpoints settings section.
        </p>
      )}

      {running?.outcome != null && !running.outcome.ok && (
        <p role="alert" className="text-xs text-danger">
          {running.outcome.reason}
        </p>
      )}
      {running?.outcome?.ok === true && (
        <p className="text-xs text-success">
          {running.operation === 'install' ? 'Installed.' : 'Updated.'}
        </p>
      )}
    </li>
  )
}

/**
 * Providers settings page: detection grid with per-CLI version, install state
 * and auth badges. Install and Update run immediately — no command dump.
 * Sign-in is offered per provider, but only for one that actually refused a
 * turn or that the user explicitly asked Ari to check.
 */
export function ProvidersView({ onOpenTerminal }: { onOpenTerminal?: () => void } = {}) {
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { installs, start, cancel } = useProviderInstalls(setDetections)
  const { auth, checking, check, dismiss } = useProviderAuth()

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

  const beginAction = async (detection: Detection, operation: 'install' | 'upgrade'): Promise<void> => {
    setError(null)
    try {
      await start(detection.kind as DriverKind, operation)
    } catch {
      setError('Could not start the operation.')
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
              auth={auth[detection.kind as DriverKind]}
              checkingAuth={checking[detection.kind as DriverKind] === true}
              onInstall={(d) => void beginAction(d, 'install')}
              onUpdate={(d) => void beginAction(d, 'upgrade')}
              onRecheck={() => void scan()}
              onCheckAuth={(kind) => void check(kind)}
              onAuthResolved={dismiss}
              onCancel={(kind) => void cancel(kind)}
              onOpenTerminal={onOpenTerminal}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

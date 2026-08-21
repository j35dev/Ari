import { useEffect, useState } from 'react'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import type { BadgeTone } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Tooltip } from '@ari/ui/tooltip'
import { RefreshCw } from 'lucide-react'
import { rpc } from '../../lib/rpc'

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

interface ProviderCardProps {
  detection: Detection
}

function ProviderCard({ detection }: ProviderCardProps) {
  const isCore = detection.kind === 'ari-core'
  const auth = authBadgeFor(isCore ? 'authenticated' : detection.authStatus)
  const badge = <Badge tone={auth.tone}>{auth.label}</Badge>

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
      {detection.binaryPath === null && !isCore ? (
        <p className="text-2xs text-danger">not installed</p>
      ) : detection.version != null ? (
        <p className="truncate font-mono text-2xs text-fg-subtle">{detection.version}</p>
      ) : null}
      {detection.binaryPath != null && (
        <p className="truncate font-mono text-2xs text-fg-subtle" title={detection.binaryPath}>
          {detection.binaryPath}
        </p>
      )}
      {isCore && (
        <p className="text-xs text-fg-muted">
          Runs on your own endpoints — manage them in the Endpoints section below.
        </p>
      )}
    </li>
  )
}

/**
 * Providers settings page (M12.2): detection grid over `providers.detect`
 * with per-CLI version, install state, and auth badges; manual re-scan.
 */
export function ProvidersView() {
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      setDetections(await rpc.invoke('providers.detect'))
      setError(null)
    } catch {
      setError('Provider detection failed.')
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void scan()
  }, [])

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
          Install a supported CLI and Re-scan.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {detections.map((detection) => (
            <ProviderCard key={detection.kind} detection={detection} />
          ))}
        </ul>
      )}
    </section>
  )
}

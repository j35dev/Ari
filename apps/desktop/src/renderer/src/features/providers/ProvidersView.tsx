import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import { DEFAULT_ACCOUNT } from '@ari/contracts/settings'
import type { CliKind, ProviderConnection, SettingsUpdate } from '@ari/contracts/settings'
import { Button } from '@ari/ui/button'
import { RefreshCw } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { useEngineSettings } from '../settings/useEngineSettings'
import { ProviderEditor } from './ProviderEditor'
import { ProviderList } from './ProviderList'
import type { ProviderListRow } from './ProviderList'
import { checkedAgo, providerStatus, shortVersion } from './provider-status'
import type { Detection } from './provider-status'
import { useProviderAuth } from './use-provider-auth'
import { useProviderInstalls } from './use-provider-installs'

const ORDER: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes', 'ari-core']

const ON: ProviderConnection = {
  enabled: true,
  binaryPath: '',
  accounts: [],
  activeAccount: DEFAULT_ACCOUNT,
}

/** How long a saved change may wait for its detection before Ari asks again. */
const RECHECK_AFTER_MS = 20_000

export interface ProvidersViewProps {
  onOpenTerminal?: () => void
  /** Leaves for the Endpoints section, where Ari Core's connections live. */
  onOpenEndpoints?: () => void
}

/**
 * Providers settings page: every agent Ari can drive with a switch beside it,
 * and for the selected one which install runs, how Ari reaches it, and whether
 * it is signed in and current. Changes save as they are made; Ari then looks
 * for the CLI again so the page shows what the next turn will really use.
 */
export function ProvidersView({ onOpenTerminal, onOpenEndpoints }: ProvidersViewProps = {}) {
  const { settings, update } = useEngineSettings()
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<DriverKind>>(() => new Set())
  const [selected, setSelected] = useState<DriverKind>('claude')
  const chosen = useRef(false)

  // A row stops waiting only when a round that looked for it again reports:
  // a round about another provider, or one begun before the change was saved,
  // would otherwise pass off the old answer as the new one.
  const receive = useCallback((rows: Detection[], checked?: readonly DriverKind[]): void => {
    setDetections(rows)
    setCheckedAt(Date.now())
    setNow(Date.now())
    setPending((current) =>
      checked === undefined
        ? new Set()
        : new Set([...current].filter((kind) => !checked.includes(kind))),
    )
  }, [])
  const { installs, start, cancel } = useProviderInstalls(receive)
  const { auth, checking, check, dismiss } = useProviderAuth()

  const scan = useCallback(
    async (method: 'providers.detect' | 'providers.rescan'): Promise<void> => {
      setScanning(true)
      try {
        // Only a rescan is certain to be newer than whatever is being waited on.
        receive(await rpc.invoke(method), method === 'providers.rescan' ? undefined : [])
        setError(null)
      } catch {
        setError('Provider detection failed.')
        setPending(new Set())
      } finally {
        setScanning(false)
      }
    },
    [receive],
  )

  useEffect(() => {
    void scan('providers.detect')
  }, [scan])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // Detection normally follows a saved change by itself; this covers the round
  // that never arrives, so a row cannot sit on "Checking" for good.
  useEffect(() => {
    if (pending.size === 0) return
    const timer = setTimeout(() => void scan('providers.rescan'), RECHECK_AFTER_MS)
    return () => clearTimeout(timer)
  }, [pending, scan])

  const connectionOf = useCallback(
    (kind: DriverKind): ProviderConnection | null =>
      kind === 'ari-core' ? null : (settings?.providers[kind] ?? ON),
    [settings],
  )

  const rows = useMemo<ProviderListRow[]>(
    () =>
      ORDER.map((kind) => {
        const connection = connectionOf(kind)
        const detection = pending.has(kind) ? undefined : detections?.find((d) => d.kind === kind)
        return {
          kind,
          enabled: connection === null ? null : connection.enabled,
          version: detection?.installed === true ? shortVersion(detection.version) : null,
          status: providerStatus({
            kind,
            detection,
            enabled: connection?.enabled !== false,
            auth: auth[kind],
            install: installs[kind],
          }),
        }
      }),
    [auth, connectionOf, detections, installs, pending],
  )

  // Open on whatever needs the user, once, and never move a selection they made.
  useEffect(() => {
    if (chosen.current || detections === null) return
    chosen.current = true
    const troubled = rows.find((row) => row.status.tone === 'error' || row.status.tone === 'warning')
    if (troubled) setSelected(troubled.kind)
  }, [detections, rows])

  const save = (kind: CliKind, patch: Partial<ProviderConnection>): void => {
    // Whoever is editing a provider has chosen it; the page must not move on.
    chosen.current = true
    setError(null)
    setPending((current) => new Set(current).add(kind))
    const providers: NonNullable<SettingsUpdate['providers']> = {}
    providers[kind] = patch
    update({ providers }).catch(() => {
      setError('Could not save the provider setting.')
      setPending((current) => {
        const next = new Set(current)
        next.delete(kind)
        return next
      })
    })
  }

  const run = (kind: DriverKind, operation: 'install' | 'upgrade'): void => {
    setError(null)
    start(kind, operation).catch(() => setError('Could not start the operation.'))
  }

  const select = (kind: DriverKind): void => {
    chosen.current = true
    setSelected(kind)
  }

  const row = rows.find((entry) => entry.kind === selected) ?? rows[0]

  return (
    <section aria-label="Providers" className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Providers</h1>
          <p className="text-sm text-fg-muted">
            Choose which agents Ari uses and which install of each it runs.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={scanning}
          title="Look for every provider again"
          onClick={() => void scan('providers.rescan')}
        >
          <RefreshCw className={`h-3.5 w-3.5${scanning ? ' animate-spin' : ''}`} />
          {scanning || checkedAt === null ? 'Checking…' : `Checked ${checkedAgo(checkedAt, now)}`}
        </Button>
      </div>

      {error != null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <div className="grid overflow-hidden rounded-lg border border-border bg-surface-1 md:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="border-b border-border md:border-b-0 md:border-r">
          <ProviderList
            rows={rows}
            selected={selected}
            onSelect={select}
            onEnabledChange={(kind, enabled) => {
              if (kind !== 'ari-core') save(kind, { enabled })
            }}
          />
        </div>
        {row !== undefined && (
          <ProviderEditor
            key={row.kind}
            kind={row.kind}
            detection={detections?.find((d) => d.kind === row.kind)}
            connection={connectionOf(row.kind)}
            status={row.status}
            checking={pending.has(row.kind) || detections === null}
            install={installs[row.kind]}
            auth={auth[row.kind]}
            checkingAuth={checking[row.kind] === true}
            onEnabledChange={(enabled) => {
              if (row.kind !== 'ari-core') save(row.kind, { enabled })
            }}
            onBinaryPathChange={(binaryPath) => {
              if (row.kind !== 'ari-core') save(row.kind, { binaryPath })
            }}
            onInstall={() => run(row.kind, 'install')}
            onUpdate={() => run(row.kind, 'upgrade')}
            onCancelInstall={() => void cancel(row.kind)}
            onCheckAuth={() => void check(row.kind)}
            onAuthResolved={() => dismiss(row.kind)}
            onOpenTerminal={onOpenTerminal}
            onOpenEndpoints={onOpenEndpoints}
          />
        )}
      </div>
    </section>
  )
}

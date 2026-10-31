import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, RefreshCw, ShieldCheck, TerminalSquare, X } from 'lucide-react'
import { driverKindSchema, type DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { ProviderLogo } from '../composer/provider-logo'
import { driverLabel } from '../composer/agent-mark'
import { providerStatus, shortVersion } from '../providers/provider-status'
import { useProviderInstalls } from '../providers/use-provider-installs'
import { useProviderAuth } from '../providers/use-provider-auth'
import { TerminalPane } from '../terminal/TerminalPane'

const log = createLogger('onboarding:agents')
const PRIMARY = ['claude', 'codex'] as const
const nameOf = (kind: string): string => (kind === 'claude' ? 'Claude Code' : driverLabel(kind))
type Detection = RpcResults['providers.detect'][number]

/** Reuses installed agents and their native sign-ins; installs require explicit confirmation. */
export function OnboardingAgents({
  selected,
  onSelect,
  onBusyChange,
}: {
  selected: DriverKind | null
  onSelect: (kind: DriverKind) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ kind: DriverKind; command: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const [terminal, setTerminal] = useState<{ id: string; cwd: string; kind: string } | null>(null)
  const alive = useRef(true)
  const actionPending = useRef(false)
  const chose = useRef(selected !== null)
  const { installs, start, cancel } = useProviderInstalls(setDetections)
  const { auth, checking, check } = useProviderAuth()
  const installing = Object.values(installs).some((state) => state?.outcome === null)
  const busy = installing || opening || terminal !== null
  const scan = useCallback(async (fresh = false) => {
    setScanning(true)
    setError(null)
    try {
      const rows = await rpc.invoke(fresh ? 'providers.rescan' : 'providers.detect')
      if (alive.current) setDetections(rows)
    } catch (error) {
      log.warn('agent detection failed', error)
      if (alive.current)
        setError('Could not check your agents. Try again, or set them up later in Settings.')
    } finally {
      if (alive.current) setScanning(false)
    }
  }, [])
  useEffect(() => {
    alive.current = true
    void scan()
    return () => {
      alive.current = false
    }
  }, [scan])
  useEffect(() => {
    if (chose.current || detections === null) return
    const available = detections.filter(
      (d) => d.installed && d.enabled !== false && d.kind !== 'ari-core',
    )
    const candidate = available.find((d) => d.authStatus === 'authenticated') ?? available[0]
    const kind = driverKindSchema.safeParse(candidate?.kind)
    if (kind.success) {
      chose.current = true
      onSelect(kind.data)
    }
  }, [detections, onSelect])
  useEffect(() => {
    onBusyChange(busy)
  }, [busy, onBusyChange])
  useEffect(
    () => () => {
      if (terminal)
        void rpc
          .invoke('terminal.kill', { id: terminal.id })
          .catch((error: unknown) => log.warn('setup terminal cleanup failed', error))
    },
    [terminal],
  )

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (actionPending.current) return
    actionPending.current = true
    setOpening(true)
    setError(null)
    try {
      await operation()
    } catch (error) {
      log.warn('agent setup failed', error)
      if (alive.current)
        setError(
          error instanceof Error ? error.message : 'Could not complete this action. Try again.',
        )
    } finally {
      actionPending.current = false
      if (alive.current) setOpening(false)
    }
  }
  const login = (kind: 'claude' | 'codex'): void => {
    void run(async () => {
      const result = await rpc.invoke('providers.setupTerminal', { kind })
      if (!result.ok) throw new Error(result.error)
      if (!alive.current) {
        await rpc.invoke('terminal.kill', { id: result.id })
        return
      }
      setTerminal({ id: result.id, cwd: result.cwd, kind })
    })
  }
  const offerInstall = (kind: DriverKind): void => {
    void run(async () => {
      const next = await rpc.invoke('providers.plan', { kind })
      if (next === null)
        throw new Error('No automatic installer is available. Install the CLI, then check again.')
      if (alive.current) setPlan({ kind, command: next.installCommand.join(' ') })
    })
  }
  const choose = (kind: DriverKind): void => {
    chose.current = true
    onSelect(kind)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
        <span className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-accent" /> Existing sign-ins stay with your agents.
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={scanning || busy}
          onClick={() => void scan(true)}
        >
          <RefreshCw
            size={13}
            className={scanning ? 'animate-spin motion-reduce:animate-none' : ''}
          />{' '}
          Check again
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-xs text-danger"
        >
          {error}
        </p>
      )}
      <div role="group" aria-label="Choose your first agent" className="space-y-3">
        {PRIMARY.map((kind) => {
          const detection = detections?.find((d) => d.kind === kind)
          const enabled = detection?.enabled !== false
          const status = providerStatus({
            kind,
            detection,
            enabled,
            auth: auth[kind],
            install: installs[kind],
          })
          const usable = detection?.installed === true && enabled
          const isSelected = selected === kind
          const isInstalling = installs[kind]?.outcome === null
          const failed = installs[kind]?.outcome
          const verified = auth[kind]?.result.status === 'ready'
          return (
            <section
              key={kind}
              aria-label={nameOf(kind)}
              className={`overflow-hidden rounded-xl border transition-colors ${isSelected ? 'border-accent/60 bg-accent-subtle/40' : 'border-border bg-surface-1'}`}
            >
              <div className="flex items-center gap-4 p-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2 [&>svg]:size-6">
                  <ProviderLogo kind={kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-fg">{nameOf(kind)}</h3>
                  <p className="mt-1 text-xs text-fg-muted">
                    {kind === 'claude'
                      ? 'Your Claude account, in Ari.'
                      : 'Your ChatGPT account, in Ari.'}
                  </p>
                </div>
                <span
                  className={`flex items-center gap-1.5 text-xs ${verified ? 'text-success' : 'text-fg-muted'}`}
                >
                  {verified && <Check size={13} />}
                  {verified
                    ? 'Connected'
                    : detection?.authStatus === 'authenticated'
                      ? 'Sign-in found'
                      : status.headline}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
                <span className="mr-auto font-mono text-2xs text-fg-subtle">
                  {usable
                    ? `CLI ${shortVersion(detection.version) ?? 'installed'}`
                    : 'Local coding agent'}
                </span>
                {!enabled ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await rpc.invoke('settings.update', {
                          providers: { [kind]: { enabled: true } },
                        })
                        await scan(true)
                      })
                    }
                  >
                    Enable agent
                  </Button>
                ) : isInstalling ? (
                  <Button size="sm" onClick={() => void run(() => cancel(kind))}>
                    Cancel install
                  </Button>
                ) : !usable ? (
                  <Button
                    size="sm"
                    disabled={busy || detections === null}
                    onClick={() => offerInstall(kind)}
                  >
                    <Download size={13} /> Install
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || checking[kind]}
                      onClick={() => void check(kind)}
                    >
                      {checking[kind] ? 'Checking…' : 'Check sign-in'}
                    </Button>
                    {status.tone !== 'ok' && status.tone !== 'update' && (
                      <Button size="sm" disabled={busy} onClick={() => login(kind)}>
                        Sign in
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={isSelected ? 'primary' : 'secondary'}
                      aria-pressed={isSelected}
                      onClick={() => choose(kind)}
                    >
                      {isSelected ? (
                        <>
                          <Check size={13} /> Selected
                        </>
                      ) : (
                        'Use this agent'
                      )}
                    </Button>
                  </>
                )}
              </div>
              {usable && detection.authStatus === 'unknown' && (
                <div className="px-4 pb-3 text-xs text-fg-muted">
                  Sign-in not verified.{' '}
                  <button
                    type="button"
                    className="text-accent underline focus-visible:outline-accent"
                    disabled={busy}
                    onClick={() => login(kind)}
                  >
                    Sign in with {nameOf(kind)}
                  </button>
                </div>
              )}
              {failed && !failed.ok && (
                <p role="alert" className="px-4 pb-3 text-xs text-danger">
                  {failed.reason} You can retry Install.
                </p>
              )}
              {auth[kind]?.result.status === 'unknown' && (
                <p className="px-4 pb-3 text-xs text-fg-muted">{auth[kind]?.result.reason}</p>
              )}
            </section>
          )
        })}
      </div>
      {plan && (
        <section
          aria-label="Confirm agent installation"
          className="rounded-xl border border-border bg-surface-2 p-4"
        >
          <h3 className="text-sm font-medium">Install {nameOf(plan.kind)}?</h3>
          <p className="mt-1 text-xs text-fg-muted">
            This downloads the agent onto your computer. Ari will run:
          </p>
          <code className="my-3 block break-all rounded-md bg-bg p-2 font-mono text-xs">
            {plan.command}
          </code>
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => setPlan(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await start(plan.kind, 'install')
                  setPlan(null)
                })
              }
            >
              Install {nameOf(plan.kind)}
            </Button>
          </div>
        </section>
      )}
      {terminal && (
        <section
          aria-label="Agent sign-in terminal"
          className="overflow-hidden rounded-xl border border-border bg-bg"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
            <TerminalSquare size={14} /> {nameOf(terminal.kind)} sign-in{' '}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setTerminal(null)
                void scan(true)
              }}
            >
              Done, check again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Close sign-in terminal"
              onClick={() => setTerminal(null)}
            >
              <X size={13} />
            </Button>
          </div>
          <p className="px-3 pt-2 text-xs text-fg-muted">
            Follow the agent’s instructions below. Your browser may open to finish sign-in.
          </p>
          <div className="h-52">
            <TerminalPane terminalId={terminal.id} cwd={terminal.cwd} attachOnly active />
          </div>
        </section>
      )}
      {detections?.some(
        (d) =>
          d.installed && d.enabled !== false && !['claude', 'codex', 'ari-core'].includes(d.kind),
      ) && (
        <div>
          <p className="mb-2 text-xs text-fg-muted">Also found on this computer</p>
          <div className="flex flex-wrap gap-2">
            {detections
              .filter(
                (d) =>
                  d.installed &&
                  d.enabled !== false &&
                  !['claude', 'codex', 'ari-core'].includes(d.kind),
              )
              .map((d) => (
                <Button
                  key={d.kind}
                  size="sm"
                  aria-pressed={selected === d.kind}
                  variant={selected === d.kind ? 'primary' : 'secondary'}
                  onClick={() => {
                    const kind = driverKindSchema.safeParse(d.kind)
                    if (kind.success) choose(kind.data)
                  }}
                >
                  <ProviderLogo kind={d.kind} /> {driverLabel(d.kind)}
                </Button>
              ))}
          </div>
        </div>
      )}
      <p className="text-xs leading-relaxed text-fg-subtle">
        No agent yet? You can continue and connect one later, or add a custom API in Settings →
        Endpoints. Nothing runs until you send a message.
      </p>
    </div>
  )
}

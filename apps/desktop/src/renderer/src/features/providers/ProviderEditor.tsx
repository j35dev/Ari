import type { ReactNode } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderConnection } from '@ari/contracts/settings'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { Switch } from '@ari/ui/switch'
import { driverLabel } from '../composer/agent-mark'
import { ProviderLogo } from '../composer/provider-logo'
import { BinaryPathField } from './BinaryPathField'
import { ProviderSignIn } from './ProviderSignIn'
import { StatusDot } from './StatusDot'
import { shortVersion } from './provider-status'
import type { Detection, ProviderStatus } from './provider-status'
import type { ProviderAuthEntry } from './use-provider-auth'
import type { InstallState } from './use-provider-installs'

export interface ProviderEditorProps {
  kind: DriverKind
  detection: Detection | undefined
  /** Null for Ari Core, which has nothing to connect to. */
  connection: ProviderConnection | null
  status: ProviderStatus
  /** A connection change was saved and detection has not caught up. */
  checking: boolean
  install: InstallState | undefined
  auth: ProviderAuthEntry | undefined
  checkingAuth: boolean
  onEnabledChange: (enabled: boolean) => void
  onBinaryPathChange: (path: string) => void
  onInstall: () => void
  onUpdate: () => void
  onCancelInstall: () => void
  onCheckAuth: () => void
  onAuthResolved: () => void
  onOpenTerminal?: (() => void) | undefined
  onOpenEndpoints?: (() => void) | undefined
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-border/60 px-5 py-4">
      <h3 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>
      {children}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-1.5">
      <span className="shrink-0 text-sm text-fg-muted">{label}</span>
      <span className="min-w-0 text-right text-sm text-fg">{children}</span>
    </div>
  )
}

/** Everything about one provider: whether it is on, which install runs, and its health. */
export function ProviderEditor({
  kind,
  detection,
  connection,
  status,
  checking,
  install,
  auth,
  checkingAuth,
  onEnabledChange,
  onBinaryPathChange,
  onInstall,
  onUpdate,
  onCancelInstall,
  onCheckAuth,
  onAuthResolved,
  onOpenTerminal,
  onOpenEndpoints,
}: ProviderEditorProps) {
  const name = driverLabel(kind)
  const version = shortVersion(detection?.version)
  const running = install != null && install.outcome === null
  const on = connection?.enabled !== false
  const live = on && !checking && detection?.enabled !== false
  const installed = live && detection?.installed === true

  return (
    <div aria-label={`${name} settings`} role="group" className="flex min-w-0 flex-col">
      <header className="flex items-start gap-3 px-5 py-4">
        <span className="mt-0.5">
          <ProviderLogo kind={kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-fg">{name}</h2>
            {installed && version !== null && (
              <code className="shrink-0 font-mono text-xs text-fg-subtle" title={detection?.version ?? undefined}>
                v{version}
              </code>
            )}
          </div>
          <p className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-fg-muted">
            <StatusDot tone={status.tone} />
            <span>
              <span className="font-medium text-fg">{status.headline}</span>
              {status.detail !== null && ` · ${status.detail}`}
            </span>
          </p>
        </div>
        {connection !== null && (
          <Switch
            checked={connection.enabled}
            onCheckedChange={onEnabledChange}
            aria-label={`Enable ${name}`}
            className="mt-0.5"
          />
        )}
      </header>

      {connection === null ? (
        <Section title="Endpoints">
          <p className="text-sm leading-relaxed text-fg-muted">
            Ari Core is Ari&apos;s own agent. It needs no CLI and talks to any OpenAI-compatible
            endpoint you add.
          </p>
          {onOpenEndpoints && (
            <Button size="sm" variant="secondary" className="mt-3" onClick={onOpenEndpoints}>
              Manage endpoints
            </Button>
          )}
        </Section>
      ) : (
        <>
          <Section title="Connection">
            <BinaryPathField
              name={name}
              command={kind}
              value={connection.binaryPath}
              detection={detection}
              checking={checking}
              off={!on}
              onCommit={onBinaryPathChange}
            />
            {installed && detection?.transport != null && (
              <div className="mt-4 border-t border-border/60 pt-3">
                <Fact label="How Ari connects">
                  <span className="text-xs text-fg-muted">{detection.transport.label}</span>
                </Fact>
                {detection.transport.note != null && (
                  <p className="mt-1 text-xs leading-relaxed text-warning">{detection.transport.note}</p>
                )}
              </div>
            )}
          </Section>

          {!on ? (
            <Section title="Status">
              <p className="text-sm leading-relaxed text-fg-muted">
                {name} is off. Ari does not launch it, check its sign-in, or list its models. Sessions
                that already use it keep their history and cannot run a new turn until it is back on.
              </p>
            </Section>
          ) : (
            <>
              <Section title="Version">
                <Fact label="Installed">
                  {running ? (
                    <span className="inline-flex items-center gap-2 text-fg-muted">
                      <Spinner className="h-3 w-3" />
                      {install?.operation === 'install' ? 'Installing…' : 'Updating…'}
                    </span>
                  ) : installed ? (
                    <span className="font-mono text-xs">{detection?.version ?? 'unknown'}</span>
                  ) : (
                    <span className="text-fg-muted">
                      {checking
                        ? 'Checking…'
                        : detection?.pathProblem !== undefined
                          ? 'Nothing at this path'
                          : 'Not installed'}
                    </span>
                  )}
                </Fact>
                {installed && detection?.updateAvailable === true && !running && (
                  <Fact label="Latest">
                    <span className="font-mono text-xs">{detection.latestVersion ?? 'newer'}</span>
                  </Fact>
                )}
                {installed && detection?.updateAvailable === false && !running && (
                  <p className="text-xs text-fg-subtle">Up to date.</p>
                )}
                {install?.outcome != null && !install.outcome.ok && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    {install.outcome.reason}
                  </p>
                )}
                {install?.outcome?.ok === true && (
                  <p className="mt-1 text-xs text-success">
                    {install.operation === 'install' ? 'Installed.' : 'Updated.'}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2 empty:hidden">
                  {running ? (
                    <Button size="sm" variant="ghost" onClick={onCancelInstall}>
                      Cancel
                    </Button>
                  ) : installed && detection?.updateAvailable === true ? (
                    <Button size="sm" onClick={onUpdate}>
                      Update
                    </Button>
                  ) : live && detection?.installed === false && connection.binaryPath === '' ? (
                    <Button size="sm" variant="secondary" onClick={onInstall}>
                      Install
                    </Button>
                  ) : null}
                </div>
              </Section>

              {installed && (
                <Section title="Account">
                  {auth != null ? (
                    <ProviderSignIn
                      kind={kind}
                      result={auth.result}
                      onOpenTerminal={onOpenTerminal}
                      onDone={onAuthResolved}
                    />
                  ) : (
                    <p className="text-xs leading-relaxed text-fg-muted">
                      {detection?.authStatus === 'authenticated'
                        ? 'A saved sign-in was found. The CLI keeps its own credentials; Ari never reads them.'
                        : (detection?.authReason ??
                          (detection?.authStatus === 'unauthenticated'
                            ? 'No saved sign-in was found. Sign in with the CLI, then check again.'
                            : 'Ari could not tell whether this CLI is signed in.'))}
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-3"
                    disabled={checkingAuth}
                    onClick={onCheckAuth}
                  >
                    {checkingAuth ? <Spinner className="h-3 w-3" /> : null} Check sign-in
                  </Button>
                </Section>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

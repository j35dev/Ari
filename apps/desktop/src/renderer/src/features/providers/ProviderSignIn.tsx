import { useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderLoginMethod } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { rpc } from '../../lib/rpc'
import { requestTerminalTab } from '../terminal/terminal-requests'
import { loginCommandLine, loginTabTitle } from './provider-login-command'
import type { AuthProbeResult } from './use-provider-auth'

export interface ProviderSignInProps {
  kind: DriverKind
  result: AuthProbeResult
  /** Switches the app to the Terminal pane; the tab is queued without it. */
  onOpenTerminal?: () => void
  onDone?: () => void
}

/**
 * The sign-in affordance for a provider that refused a turn: one button per
 * login the agent itself advertised, each opening a terminal tab that runs the
 * agent's own login command.
 *
 * Ari never performs the OAuth and never stores a token — the CLI does its own
 * login and writes its own credential store, exactly as it would if the user
 * had opened a terminal themselves. The only thing Ari adds is knowing which
 * command to run and where.
 */
export function ProviderSignIn({ kind, result, onOpenTerminal, onDone }: ProviderSignInProps) {
  const [busy, setBusy] = useState(false)
  const [launched, setLaunched] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (result.status === 'ready') {
    return <p className="text-2xs text-success">Signed in — this provider is ready.</p>
  }
  if (result.status === 'unknown') {
    return <p className="text-2xs text-fg-subtle">{result.reason}</p>
  }

  const runLogin = async (login: ProviderLoginMethod): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const info = await rpc.invoke('app.info')
      requestTerminalTab({
        title: loginTabTitle(login),
        cwd: info.homeDir,
        command: loginCommandLine(login, info.platform),
      })
      setLaunched(login.name)
      onOpenTerminal?.()
      onDone?.()
    } catch {
      setError('Could not open a terminal for the sign-in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`provider-signin-${kind}`}>
      <p role="alert" className="text-2xs text-warning">
        {result.label} needs you to sign in again.
      </p>

      {result.logins.length === 0 ? (
        <p className="text-2xs text-fg-subtle">
          This agent did not offer a sign-in Ari can run. Run its login once in a terminal, then
          re-check.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {result.logins.map((login) => (
            <Button
              key={login.methodId}
              size="sm"
              disabled={busy}
              title={login.description.length > 0 ? login.description : undefined}
              onClick={() => void runLogin(login)}
            >
              {busy ? <Spinner className="h-3 w-3" /> : null} {login.name}
            </Button>
          ))}
        </div>
      )}

      {launched != null && (
        <p className="text-2xs text-fg-muted">
          Opened “{launched}” in the Terminal. Finish there, then send your message again.
        </p>
      )}
      {error != null && (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

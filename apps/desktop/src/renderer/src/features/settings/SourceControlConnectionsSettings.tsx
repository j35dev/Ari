import { useState } from 'react'
import { Check, ChevronDown, ExternalLink, Plus, X } from 'lucide-react'
import type { SourceControlEnvironment, SourceControlProvider } from '@ari/contracts/rpc'
import { sourceControlProviders } from '@ari/contracts/source-control-providers'
import { Button } from '@ari/ui/button'
import { rpc } from '../../lib/rpc'
import { SourceControlMark } from '../changes/SourceControlMark'

const inputClass =
  'h-9 w-full rounded-md border border-border bg-bg px-3 text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

export function SourceControlConnectionsSettings({
  environment,
  onChanged,
}: {
  environment: SourceControlEnvironment | null
  onChanged: () => void
}) {
  const [active, setActive] = useState<SourceControlProvider | null>(null)
  const [instance, setInstance] = useState('')
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const select = (provider: (typeof sourceControlProviders)[number]) => {
    setActive(active === provider.id ? null : provider.id)
    setInstance(provider.instance)
    setToken('')
    setUsername('')
    setError(null)
  }
  const connect = async (): Promise<void> => {
    if (!active || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await rpc.invoke('scm.connect', {
        provider: active,
        instance: instance.trim(),
        token,
        username,
      })
      if (result.ok) {
        setToken('')
        setActive(null)
        onChanged()
      } else setError(result.error.message)
    } catch {
      setError('Could not save this connection. Use an HTTPS instance URL and retry.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await rpc.invoke('scm.disconnect', { id })
      if (result.ok) onChanged()
      else setError(result.error.message)
    } catch {
      setError('Could not remove this connection. Retry.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="divide-y divide-border/60">
      {sourceControlProviders.map((provider) => {
        const connections =
          environment?.connections?.filter((entry) => entry.provider === provider.id) ?? []
        const cli =
          provider.id === 'github'
            ? environment?.github
            : provider.id === 'gitlab'
              ? environment?.gitlab
              : null
        const connected = connections.length > 0 || !!cli?.account
        return (
          <div key={provider.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50"
              aria-expanded={active === provider.id}
              aria-label={`Configure ${provider.label}`}
              disabled={busy}
              onClick={() => select(provider)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
                <SourceControlMark provider={provider.id} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{provider.label}</span>
                <span className="mt-0.5 block text-xs text-fg-subtle">{provider.description}</span>
              </span>
              {connected ? (
                <span className="flex items-center gap-1.5 text-xs text-success">
                  <Check size={12} aria-hidden />
                  {connections.length ? `${connections.length} connected` : 'CLI connected'}
                </span>
              ) : (
                <span className="text-xs text-fg-muted">Connect</span>
              )}
              <ChevronDown
                size={13}
                className={`text-fg-subtle transition-transform ${active === provider.id ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
            {active === provider.id ? (
              <div className="pb-4 pl-12">
                {connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="mb-3 flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs"
                  >
                    <Check size={12} className="shrink-0 text-success" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-fg" title={connection.instance}>
                        {connection.instance.replace('https://', '')}
                      </p>
                      <p className="mt-0.5 text-2xs text-fg-muted">
                        {connection.account ?? 'Access token'} ·{' '}
                        {connection.hasToken ? 'Token saved' : 'CLI authentication'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Disconnect ${connection.instance}`}
                      title="Disconnect this instance"
                      onClick={() => void remove(connection.id)}
                      className="rounded p-1 text-fg-subtle hover:bg-danger-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void connect()
                  }}
                >
                  <fieldset disabled={busy} className="space-y-3">
                    {connections.length ? (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-fg">
                        <Plus size={12} />
                        Connect another instance
                      </p>
                    ) : null}
                    <label className="block text-xs text-fg-muted">
                      Instance URL
                      <input
                        type="url"
                        aria-label={`${provider.label} instance URL`}
                        required
                        value={instance}
                        onChange={(event) => setInstance(event.target.value)}
                        className={`${inputClass} mt-1.5`}
                        placeholder={
                          provider.id === 'azure-devops'
                            ? 'https://dev.azure.com/your-organization'
                            : provider.instance
                        }
                      />
                    </label>
                    {provider.id === 'azure-devops' ? (
                      <p className="text-2xs text-fg-subtle">
                        Include your organization, or your server's collection URL.
                      </p>
                    ) : null}
                    {provider.id === 'bitbucket' ? (
                      <label className="block text-xs text-fg-muted">
                        Atlassian email (for an API token)
                        <input
                          aria-label="Atlassian email"
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                          autoComplete="off"
                          className={`${inputClass} mt-1.5`}
                        />
                      </label>
                    ) : null}
                    <label className="block text-xs text-fg-muted">
                      Access token{provider.cli ? ' (optional with CLI login)' : ''}
                      <input
                        type="password"
                        aria-label={`${provider.label} access token`}
                        required={!provider.cli}
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        autoComplete="new-password"
                        maxLength={16384}
                        className={`${inputClass} mt-1.5`}
                        placeholder={
                          provider.cli
                            ? `Use a token or your ${provider.cli} login`
                            : 'Paste your access token'
                        }
                      />
                    </label>
                    <p className="text-xs leading-relaxed text-fg-subtle">
                      {provider.tokenHint} Tokens are encrypted on this device.
                    </p>
                    {error ? (
                      <p role="alert" className="text-xs text-danger">
                        {error}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                        onClick={() =>
                          void rpc
                            .invoke('shell.openUrl', { url: provider.tokenUrl })
                            .catch(() => setError('Could not open the token page.'))
                        }
                      >
                        Get a token
                        <ExternalLink size={11} aria-hidden />
                      </button>
                      <Button type="submit" size="sm" variant="primary">
                        {busy ? 'Connecting…' : 'Connect'}
                      </Button>
                    </div>
                  </fieldset>
                </form>
              </div>
            ) : null}
          </div>
        )
      })}
      {error && !active ? (
        <p role="alert" className="py-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

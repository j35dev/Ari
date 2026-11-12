import { useState } from 'react'
import { ChevronDown, ExternalLink, Plus, X } from 'lucide-react'
import type { SourceControlEnvironment, SourceControlProvider } from '@ari/contracts/rpc'
import { sourceControlProviders } from '@ari/contracts/source-control-providers'
import { Button } from '@ari/ui/button'
import { outlineButton, quietButton, rowAction } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import { SourceControlMark } from '../changes/SourceControlMark'
import { SETTINGS_FIELD_CLASS, SETTINGS_HINT_CLASS, SETTINGS_LABEL_CLASS } from './SettingsSection'

const inputClass = `${SETTINGS_FIELD_CLASS} w-full`

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
    <div className="divide-y divide-border">
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
          <div key={provider.id} className="first:[&>button]:rounded-t-xl">
            <button
              type="button"
              className="grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3.5 text-left transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring disabled:opacity-50 sm:grid-cols-[2rem_minmax(0,1fr)_auto_auto]"
              aria-expanded={active === provider.id}
              aria-controls={`source-control-connection-${provider.id}`}
              aria-label={`Configure ${provider.label}`}
              disabled={busy}
              onClick={() => select(provider)}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
                <SourceControlMark provider={provider.id} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block ${SETTINGS_LABEL_CLASS}`}>{provider.label}</span>
                <span className={`mt-0.5 block ${SETTINGS_HINT_CLASS}`}>
                  {provider.description}
                </span>
              </span>
              {connected ? (
                <span className="col-start-2 row-start-2 flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] text-fg-subtle sm:col-start-3 sm:row-start-1">
                  <span className="ari-status" data-status="done" aria-hidden />
                  {connections.length ? `${connections.length} connected` : 'CLI connected'}
                </span>
              ) : (
                <span
                  className={`col-start-2 row-start-2 w-fit sm:col-start-3 sm:row-start-1 ${outlineButton}`}
                >
                  Connect
                </span>
              )}
              <ChevronDown
                size={14}
                strokeWidth={1.7}
                className={`col-start-3 row-start-1 shrink-0 text-fg-subtle transition-transform sm:col-start-4 ${active === provider.id ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
            {active === provider.id ? (
              <div
                id={`source-control-connection-${provider.id}`}
                className="px-4 pb-4 sm:pl-[60px]"
              >
                {connections.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex items-center gap-2.5 border-b border-border py-2.5 text-[13px]"
                  >
                    <span className="ari-status" data-status="done" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-fg" title={connection.instance}>
                        {connection.instance.replace('https://', '')}
                      </p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {connection.account ?? 'Access token'},{' '}
                        {connection.hasToken ? 'token saved' : 'CLI authentication'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Disconnect ${connection.instance}`}
                      title="Disconnect this instance"
                      onClick={() => void remove(connection.id)}
                      className={rowAction}
                    >
                      <X size={14} strokeWidth={1.7} />
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void connect()
                  }}
                >
                  <fieldset disabled={busy} className="space-y-3 pt-3">
                    {connections.length ? (
                      <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                        <Plus size={14} strokeWidth={1.7} />
                        Connect another instance
                      </p>
                    ) : null}
                    <label className="block text-[13px] text-fg-subtle">
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
                      <p className="text-xs text-fg-subtle">
                        Include your organization, or your server's collection URL.
                      </p>
                    ) : null}
                    {provider.id === 'bitbucket' ? (
                      <label className="block text-[13px] text-fg-subtle">
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
                    <label className="block text-[13px] text-fg-subtle">
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
                    <p className={SETTINGS_HINT_CLASS}>
                      {provider.tokenHint} Tokens are encrypted on this device.
                    </p>
                    {error ? (
                      <p role="alert" className="text-[13px] text-danger">
                        {error}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className={`-ml-2.5 ${quietButton}`}
                        onClick={() =>
                          void rpc
                            .invoke('shell.openUrl', { url: provider.tokenUrl })
                            .catch(() => setError('Could not open the token page.'))
                        }
                      >
                        Get a token
                        <ExternalLink size={12} strokeWidth={1.7} aria-hidden />
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
        <p role="alert" className="px-4 py-3.5 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { Button } from '@ari/ui/button'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import {
  slackAppManifest,
  slackConfigureSchema,
  type SlackSnapshot,
  type SlackRoute,
} from '@ari/contracts/slack'
import { rpc } from '../../lib/rpc'
import { outlineButton, quietButton } from '../../lib/recipes'
import { SettingsPage } from './SettingsPage'
import { SettingsSection, SETTINGS_FIELD_CLASS, SETTINGS_HINT_CLASS } from './SettingsSection'
import { SettingsRow } from './SettingsRow'

const field = `${SETTINGS_FIELD_CLASS} w-full`
const statusLabels: Record<SlackSnapshot['status'], string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  error: 'Needs attention',
}

interface AgentDraft {
  rowIndex: number
  projectId: string
  driverKind: DriverKind | ''
  modelId: string
  effort: string
  permissionMode: PermissionMode
}

export function SlackSettings() {
  const [snapshot, setSnapshot] = useState<SlackSnapshot | null>(null)
  const [owner, setOwner] = useState('')
  const [botToken, setBotToken] = useState('')
  const [appToken, setAppToken] = useState('')
  const [permission, setPermission] = useState<PermissionMode>('ask')
  const [routes, setRoutes] = useState<SlackRoute[]>([{ channelId: '', projectId: '' }])
  const [agent, setAgent] = useState<AgentDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function apply(value: SlackSnapshot, hydrate: boolean) {
    setSnapshot(value)
    if (hydrate) {
      setOwner(value.ownerUserId)
      setPermission(value.permissionMode)
      setRoutes(
        value.routes.length
          ? value.routes.map((route) => ({ ...route }))
          : [{ channelId: '', projectId: '' }],
      )
    }
  }

  useEffect(() => {
    let active = true
    void rpc
      .invoke('slack.get')
      .then((value) => {
        if (active) apply(value, true)
      })
      .catch(() => {
        if (active)
          setError('Could not load the Slack connection. Close and reopen this settings page.')
      })
    const off = rpc.subscribe('slack.updates', {}, (payload) => {
      if (active && payload !== null && typeof payload === 'object' && 'status' in payload)
        setSnapshot(payload as SlackSnapshot)
    })
    const refresh = () => {
      void rpc
        .invoke('slack.get')
        .then((value) => {
          if (active) setSnapshot(value)
        })
        .catch(() => undefined)
    }
    const offProviders = rpc.subscribe('providers.updates', {}, refresh)
    const offProjects = rpc.subscribe('projects.changed', {}, refresh)
    return () => {
      active = false
      off()
      offProviders()
      offProjects()
    }
  }, [])

  async function connect() {
    const candidate = {
      ownerUserId: owner.trim(),
      permissionMode: permission,
      routes: routes.map((route) => ({
        channelId: route.channelId.trim(),
        projectId: route.projectId,
      })),
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
    }
    const parsed = slackConfigureSchema.safeParse(candidate)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Complete the connection details.')
      return
    }
    if (!snapshot?.hasCredentials && (!candidate.botToken || !candidate.appToken)) {
      setError('Enter both Slack tokens to connect the app.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await rpc.invoke('slack.configure', parsed.data)
      if (result.ok) {
        apply(result.snapshot, true)
        setBotToken('')
        setAppToken('')
      } else setError(result.error.message)
    } catch {
      setError('Could not configure Slack. Check the connection state before retrying.')
    } finally {
      setBusy(false)
    }
  }

  async function stop(forget: boolean) {
    setBusy(true)
    setError(null)
    try {
      const result = await rpc.invoke(forget ? 'slack.forget' : 'slack.disconnect')
      if (result.ok) {
        apply(result.snapshot, forget)
        if (forget) {
          setBotToken('')
          setAppToken('')
          setAgent(null)
        }
      } else setError(result.error.message)
    } catch {
      setError('Could not confirm the saved connection state. Check it before restarting Ari.')
    } finally {
      setBusy(false)
    }
  }

  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(slackAppManifest, null, 2))
      setCopied(true)
    } catch {
      setError('Could not copy the manifest. Keep Ari focused and try again.')
    }
  }

  function editRoute(index: number, update: Partial<SlackRoute>) {
    setRoutes((current) =>
      current.map((route, position) => (position === index ? { ...route, ...update } : route)),
    )
  }

  function editAgent(projectId: string, rowIndex: number) {
    const saved = snapshot?.projects.find((project) => project.id === projectId)?.defaultAgent
    setAgent({
      projectId,
      rowIndex,
      driverKind: saved?.driverKind ?? '',
      modelId: saved?.modelId ?? '',
      effort: saved?.effort ?? '',
      permissionMode: saved?.permissionMode ?? permission,
    })
    setError(null)
  }

  async function saveAgent() {
    if (!agent?.driverKind || !agent.modelId) return
    setBusy(true)
    setError(null)
    try {
      const project = await rpc.invoke('project.setDefaultAgent', {
        id: agent.projectId,
        value: {
          driverKind: agent.driverKind,
          modelId: agent.modelId,
          effort: agent.effort || null,
          permissionMode: agent.permissionMode,
        },
      })
      if (!project) {
        setError('This project is unavailable. Select it again.')
        return
      }
      apply(await rpc.invoke('slack.get'), false)
      setAgent(null)
    } catch {
      setError('Could not save the project’s default agent. Check its provider and model.')
    } finally {
      setBusy(false)
    }
  }

  const provider = snapshot?.providers.find((provider) => provider.driverKind === agent?.driverKind)
  const model = provider?.models.find((model) => model.id === agent?.modelId)

  return (
    <SettingsPage
      title="Integrations"
      description="Start project work from the apps you already use."
    >
      <SettingsSection
        title="Slack"
        action={
          <span role="status" className="flex items-center gap-1.5 text-[13px] text-fg-subtle">
            <span
              className={`size-1.5 rounded-full ${snapshot?.status === 'connected' ? 'bg-accent' : 'bg-fg-subtle/50'}`}
            />
            {snapshot ? statusLabels[snapshot.status] : 'Loading'}
          </span>
        }
      >
        <div className="flex items-start gap-3 px-4 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
            <MessageSquare size={18} strokeWidth={1.7} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">Meet Aria in your Slack threads</p>
            <p className={`mt-1 ${SETTINGS_HINT_CLASS}`}>
              Mention <span className="font-medium text-fg">@Aria</span> to start an isolated Ari
              session. Keep mentioning it in that thread for follow-ups, status, and stop.
            </p>
            {snapshot?.workspace && (
              <p className="mt-2 text-[13px] text-fg-muted">
                {snapshot.workspace.name} · {snapshot.taskCount} linked{' '}
                {snapshot.taskCount === 1 ? 'task' : 'tasks'}
              </p>
            )}
          </div>
        </div>
        <div className="space-y-3 px-4 py-4">
          <ol className={`list-decimal space-y-1.5 pl-4 ${SETTINGS_HINT_CLASS}`}>
            <li>Create a Slack app from the manifest below, then install it in your workspace.</li>
            <li>
              Enable Socket Mode and generate an app-level token with{' '}
              <code className="text-fg-muted">connections:write</code>.
            </li>
            <li>
              Copy your member ID from your Slack profile and invite @Aria into each mapped channel.
            </li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button className={outlineButton} onClick={() => void copyManifest()}>
              <span className="flex items-center gap-1.5">
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? 'Manifest copied' : 'Copy app manifest'}
              </span>
            </Button>
            <Button
              className={quietButton}
              onClick={() =>
                void rpc
                  .invoke('shell.openUrl', { url: 'https://api.slack.com/apps' })
                  .catch(() => setError('Could not open Slack app settings.'))
              }
            >
              <span className="flex items-center gap-1.5">
                Slack app settings
                <ExternalLink size={12} />
              </span>
            </Button>
          </div>
        </div>
      </SettingsSection>

      {snapshot && (
        <>
          <SettingsSection
            title="Connection"
            description="Tokens are encrypted with your system keyring and stay on this machine."
          >
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-[13px] text-fg-muted">
                <span className="block">Bot OAuth token</span>
                <input
                  className={field}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Bot OAuth token"
                  placeholder={snapshot.hasCredentials ? 'Saved · leave blank to keep' : 'xoxb-…'}
                  value={botToken}
                  disabled={busy}
                  onChange={(event) => setBotToken(event.target.value)}
                />
              </label>
              <label className="space-y-1.5 text-[13px] text-fg-muted">
                <span className="block">App-level token</span>
                <input
                  className={field}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="App-level token"
                  placeholder={snapshot.hasCredentials ? 'Saved · leave blank to keep' : 'xapp-…'}
                  value={appToken}
                  disabled={busy}
                  onChange={(event) => setAppToken(event.target.value)}
                />
              </label>
              <label className="space-y-1.5 text-[13px] text-fg-muted">
                <span className="block">Your Slack member ID</span>
                <input
                  className={field}
                  aria-label="Your Slack member ID"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="U…"
                  value={owner}
                  disabled={busy}
                  onChange={(event) => setOwner(event.target.value)}
                />
              </label>
              <label className="space-y-1.5 text-[13px] text-fg-muted">
                <span className="block">Maximum permissions</span>
                <select
                  className={field}
                  aria-label="Maximum permissions"
                  value={permission}
                  disabled={busy}
                  onChange={(event) => setPermission(event.target.value as PermissionMode)}
                >
                  <option value="ask">Ask for approval</option>
                  <option value="allow-edits">Allow edits</option>
                  <option value="full">Full access</option>
                </select>
              </label>
            </div>
            <div className={`px-4 py-3 ${SETTINGS_HINT_CLASS}`}>
              Only this Slack member can start or control tasks. Each project’s permission mode is
              capped by this connection.
            </div>
          </SettingsSection>

          <SettingsSection
            title="Channel access"
            description="Map each Slack channel ID to one registered project."
            action={
              <Button
                className={quietButton}
                disabled={busy || routes.length >= 32}
                onClick={() =>
                  setRoutes((current) => [...current, { channelId: '', projectId: '' }])
                }
              >
                <span className="flex items-center gap-1">
                  <Plus size={13} />
                  Add channel
                </span>
              </Button>
            }
          >
            {routes.map((route, index) => {
              const project = snapshot.projects.find((project) => project.id === route.projectId)
              return (
                <div key={index} className="space-y-2.5 px-4 py-4">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_2rem] items-end gap-2.5">
                    <label className="space-y-1.5 text-[13px] text-fg-muted">
                      <span className="block">Channel ID</span>
                      <input
                        className={field}
                        aria-label={`Channel ID ${index + 1}`}
                        placeholder="C…"
                        autoComplete="off"
                        spellCheck={false}
                        value={route.channelId}
                        disabled={busy}
                        onChange={(event) => editRoute(index, { channelId: event.target.value })}
                      />
                    </label>
                    <label className="space-y-1.5 text-[13px] text-fg-muted">
                      <span className="block">Project</span>
                      <select
                        className={field}
                        aria-label={`Project ${index + 1}`}
                        value={route.projectId}
                        disabled={busy}
                        onChange={(event) => editRoute(index, { projectId: event.target.value })}
                      >
                        <option value="">Choose a project</option>
                        {snapshot.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      aria-label={`Remove channel ${index + 1}`}
                      className="flex h-8 items-center justify-center rounded-md text-fg-subtle hover:bg-fg/5 hover:text-fg disabled:opacity-40"
                      disabled={busy || routes.length === 1}
                      onClick={() =>
                        setRoutes((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {project && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className={SETTINGS_HINT_CLASS}>
                        {project.ready
                          ? `${project.defaultAgent?.driverKind} · ${project.defaultAgent?.modelId}`
                          : project.reason}
                      </p>
                      <Button
                        className={quietButton}
                        disabled={busy}
                        onClick={() => editAgent(project.id, index)}
                      >
                        {project.defaultAgent ? 'Edit default agent' : 'Choose default agent'}
                      </Button>
                    </div>
                  )}
                  {agent?.projectId === route.projectId && agent.rowIndex === index && (
                    <div className="space-y-3 border-t border-border pt-3">
                      <p className={SETTINGS_HINT_CLASS}>
                        Project defaults apply to desktop and Slack sessions.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5 text-[13px] text-fg-muted">
                          <span className="block">Agent</span>
                          <select
                            className={field}
                            aria-label="Default project agent"
                            value={agent.driverKind}
                            disabled={busy}
                            onChange={(event) =>
                              setAgent({
                                ...agent,
                                driverKind: event.target.value as DriverKind,
                                modelId: '',
                                effort: '',
                              })
                            }
                          >
                            <option value="">Choose an agent</option>
                            {snapshot.providers.map((provider) => (
                              <option
                                key={provider.driverKind}
                                value={provider.driverKind}
                                disabled={!provider.available}
                              >
                                {provider.driverKind}
                                {provider.available ? '' : ' · unavailable'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1.5 text-[13px] text-fg-muted">
                          <span className="block">Model</span>
                          <select
                            className={field}
                            aria-label="Default project model"
                            value={agent.modelId}
                            disabled={busy || !agent.driverKind}
                            onChange={(event) =>
                              setAgent({ ...agent, modelId: event.target.value, effort: '' })
                            }
                          >
                            <option value="">Choose a model</option>
                            {agent.modelId &&
                              !provider?.models.some((model) => model.id === agent.modelId) && (
                                <option value={agent.modelId}>{agent.modelId} · unavailable</option>
                              )}
                            {provider?.models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1.5 text-[13px] text-fg-muted">
                          <span className="block">Reasoning effort</span>
                          <select
                            className={field}
                            aria-label="Default project effort"
                            value={agent.effort}
                            disabled={busy}
                            onChange={(event) => setAgent({ ...agent, effort: event.target.value })}
                          >
                            <option value="">Auto for each task</option>
                            {agent.effort && !model?.efforts.includes(agent.effort) && (
                              <option value={agent.effort}>{agent.effort}</option>
                            )}
                            {model?.efforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1.5 text-[13px] text-fg-muted">
                          <span className="block">Project permissions</span>
                          <select
                            className={field}
                            aria-label="Default project permissions"
                            value={agent.permissionMode}
                            disabled={busy}
                            onChange={(event) =>
                              setAgent({
                                ...agent,
                                permissionMode: event.target.value as PermissionMode,
                              })
                            }
                          >
                            <option value="ask">Ask for approval</option>
                            <option value="allow-edits">Allow edits</option>
                            <option value="full">Full access</option>
                          </select>
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          className={outlineButton}
                          disabled={busy || !agent.driverKind || !agent.modelId}
                          onClick={() => void saveAgent()}
                        >
                          Save default agent
                        </Button>
                        <Button
                          className={quietButton}
                          disabled={busy}
                          onClick={() => setAgent(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            <div className={`px-4 py-3 ${SETTINGS_HINT_CLASS}`}>
              Replies are visible to members of mapped channels. Copy the channel ID from its Slack
              details, then invite @Aria.
            </div>
          </SettingsSection>

          <SettingsSection title="Availability">
            <SettingsRow
              label="Runs on this machine"
              hint="Keep Ari open and your computer awake to receive mentions. Accepted tasks use Ari’s normal journals and worktrees."
            />
            <SettingsRow
              label="Request recovery"
              hint={
                snapshot.uncertainRequests || snapshot.uncertainDeliveries
                  ? `${snapshot.uncertainRequests} uncertain request(s) and ${snapshot.uncertainDeliveries} unconfirmed Slack delivery receipt(s). Inspect the original task and thread before resending.`
                  : 'Retried mentions recover the original request. Status updates share one message per thread.'
              }
            />
          </SettingsSection>

          {!snapshot.secureStorageAvailable && (
            <p role="alert" className={SETTINGS_HINT_CLASS}>
              OS-backed secure storage is unavailable. Unlock your system keyring before connecting
              Slack.
            </p>
          )}
          {(error || snapshot.message) && (
            <p
              role="alert"
              className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[13px] leading-5 text-fg"
            >
              {error ?? snapshot.message}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className={outlineButton}
              disabled={busy || !snapshot.secureStorageAvailable}
              onClick={() => void connect()}
            >
              {busy ? 'Working…' : snapshot.hasCredentials ? 'Save and reconnect' : 'Connect Slack'}
            </Button>
            {snapshot.enabled && (
              <Button className={quietButton} disabled={busy} onClick={() => void stop(false)}>
                Disconnect
              </Button>
            )}
            {(snapshot.hasCredentials || snapshot.status === 'error') && (
              <Button className={quietButton} disabled={busy} onClick={() => void stop(true)}>
                Forget Slack connection
              </Button>
            )}
          </div>
          {snapshot.hasCredentials && (
            <p className={SETTINGS_HINT_CLASS}>
              Forgetting clears the saved tokens and Slack task history. The sessions remain
              available in Ari.
            </p>
          )}
        </>
      )}
      {!snapshot && error && (
        <p role="alert" className={SETTINGS_HINT_CLASS}>
          {error}
        </p>
      )}
    </SettingsPage>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { motion } from 'motion/react'
import { PlugZap } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { useToast } from '@ari/ui/toast'
import { transitions } from '@ari/ui/motion'
import { card, outlineButton, primaryButton, sectionLabel } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import { anchorBelow, type MenuAnchor } from '../../shell/ContextMenu'
import type { SessionStartIntent } from '../../shell/session-start-focus'
import { DitherScene } from '../scene/DitherScene'

const log = createLogger('welcome')
const CHECK_TIMEOUT_MS = 15_000

type SetupCheck<T> = { status: 'loading' | 'error' } | { status: 'success'; value: T }

/** Each check can fail or retry independently, without discarding the other's result. */
function useSetupCheck<T>(load: (fresh: boolean) => Promise<T>) {
  const [state, setState] = useState<SetupCheck<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    const timer = setTimeout(() => {
      if (!active) return
      active = false
      log.warn('setup check timed out')
      setState({ status: 'error' })
    }, CHECK_TIMEOUT_MS)
    void load(attempt > 0)
      .then((value) => {
        if (active) setState({ status: 'success', value })
      })
      .catch((error: unknown) => {
        log.warn('setup check failed', error)
        if (active) setState({ status: 'error' })
      })
      .finally(() => clearTimeout(timer))
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [attempt, load])
  return { state, retry: () => setAttempt((previous) => previous + 1) }
}

const detectProviders = (fresh: boolean) =>
  rpc.invoke(fresh ? 'providers.rescan' : 'providers.detect')
const listEndpoints = () => rpc.invoke('endpoints.list').then((list) => list.length > 0)

const CLI_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok Build',
  pi: 'Pi',
  hermes: 'Hermes',
}

const KEYBOARD_HINTS = [
  ['Mod+N', 'New session'],
  ['Mod+K', 'Palette'],
  ['@', 'Mention file'],
  ['/', 'Commands'],
] as const

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'Endpoint'
  }
}

function createId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef != null && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID()
  }
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * First-run surface: shows which agent CLIs are installed, and — when neither
 * a CLI nor a model endpoint is available — offers an inline connect form so
 * Ari Core chat works immediately after setup.
 *
 * Starting a session needs a project, so the session entry point hands its
 * anchor to App, which opens the project picker under the button that was
 * pressed. With no projects yet the button instead says what to do about it.
 */
export function WelcomePanel({
  hasProjects,
  onCreateSession,
  onConnect,
  startPending = false,
  onStartIntent,
}: {
  hasProjects: boolean
  onCreateSession: (anchor: MenuAnchor) => void
  onConnect: (endpointId: string, anchor: MenuAnchor, intent?: SessionStartIntent) => void
  startPending?: boolean
  onStartIntent?: () => SessionStartIntent | null
}) {
  const { toast } = useToast()
  const providers = useSetupCheck(detectProviders)
  const endpoints = useSetupCheck(listEndpoints)
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' })
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const endpointIdRef = useRef<string | null>(null)
  const [savedForm, setSavedForm] = useState<{
    id: string
    baseUrl: string
    model: string
    apiKey: string | null
  } | null>(null)
  const normalized = {
    baseUrl: form.baseUrl.trim().replace(/\/+$/, ''),
    model: form.model.trim(),
    apiKey: form.apiKey.trim() || null,
  }
  const alreadySaved =
    savedForm !== null &&
    savedForm.baseUrl === normalized.baseUrl &&
    savedForm.model === normalized.model &&
    savedForm.apiKey === normalized.apiKey
  const mountedRef = useRef(true)
  const connectIntentRef = useRef<SessionStartIntent | null>(null)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      connectIntentRef.current?.cancel()
    }
  }, [])
  const [formError, setFormError] = useState<string | null>(null)
  /** The connect button, so the session's project picker opens beneath it. */
  const connectButtonRef = useRef<HTMLButtonElement>(null)

  const clis = useMemo(
    () =>
      (providers.state.status === 'success' ? providers.state.value : [])
        .filter((d) => d.kind !== 'ari-core' && d.enabled !== false)
        .map((d) => ({
          kind: d.kind,
          label: CLI_LABELS[d.kind] ?? d.kind,
          installed: d.binaryPath !== null,
          version: d.version,
          authenticated: d.authStatus === 'authenticated',
        })),
    [providers.state],
  )
  const anyCliInstalled = clis.some((c) => c.installed)
  const needsSetup =
    providers.state.status === 'success' &&
    endpoints.state.status === 'success' &&
    !anyCliInstalled &&
    !endpoints.state.value
  const checking = providers.state.status === 'loading' || endpoints.state.status === 'loading'
  const failedChecks = [
    ...(providers.state.status === 'error' ? ['local agents'] : []),
    ...(endpoints.state.status === 'error' ? ['saved model endpoints'] : []),
  ]

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (savingRef.current || startPending) return
    const { baseUrl, model, apiKey } = normalized
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      setFormError('Enter an http(s) base URL, e.g. https://api.openai.com/v1')
      return
    }
    if (model === '') {
      setFormError('Enter a model id, e.g. gpt-4o-mini.')
      return
    }
    const intent = onStartIntent?.()
    if (onStartIntent && intent == null) return
    savingRef.current = true
    setSaving(true)
    setFormError(null)
    connectIntentRef.current = intent ?? null
    try {
      let endpointId = savedForm?.id
      if (!alreadySaved) {
        // An upsert acknowledgement can be lost too. Retrying the same form
        // keeps its identity instead of minting a second saved endpoint.
        endpointIdRef.current ??= createId()
        const saved = await rpc.invoke('endpoints.upsert', {
          id: endpointIdRef.current,
          name: hostLabel(baseUrl),
          baseUrl,
          flavor: 'openai-chat',
          model,
          apiKey,
          headers: {},
        })
        endpointId = saved.id
        if (mountedRef.current) setSavedForm({ id: saved.id, baseUrl, model, apiKey })
        toast({ title: 'Model saved', description: `${saved.name} · ${model}`, tone: 'success' })
      }
      if (!mountedRef.current || !endpointId) {
        intent?.cancel()
        return
      }
      const trigger = connectButtonRef.current
      onConnect(endpointId, trigger ? anchorBelow(trigger) : { x: 24, y: 88 }, intent ?? undefined)
      connectIntentRef.current = null // The shell now owns completion/recovery.
    } catch (e) {
      intent?.dispose()
      if (mountedRef.current) setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <div className="relative h-full">
      <DitherScene kind="session" />
      {/* After the scene in the DOM, so the page paints over it without a
          z-index. The spacers sit the column a little above the middle. */}
      <div className="ari-scroll relative flex h-full flex-col overflow-y-auto px-8">
        <div className="min-h-10 flex-[2]" aria-hidden="true" />
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitions.fadeUp}
          className="mx-auto flex w-full max-w-[640px] shrink-0 flex-col items-start gap-4"
        >
          <div>
            <h1 className="text-[28px] font-[550] leading-9 tracking-[-0.02em] text-fg">
              Ari
              <span aria-hidden="true" className="text-accent">
                .
              </span>
            </h1>
            <p className="mt-2 max-w-[520px] text-sm leading-relaxed text-fg">
              One unified surface for every coding agent on your machine — chat, steer, review
              diffs, and drive terminals.
            </p>
          </div>

          <button
            type="button"
            disabled={startPending || saving}
            onClick={(e) => onCreateSession(anchorBelow(e.currentTarget))}
            className={primaryButton}
          >
            {hasProjects ? 'Start a new session' : 'Add a project to start'}
          </button>

          {checking ? (
            <p role="status" className="flex items-center gap-2 text-[13px] text-fg-muted">
              <span className="ari-status" data-status="working" aria-hidden="true" />
              Checking local agents and saved model endpoints…
            </p>
          ) : null}
          {failedChecks.length > 0 ? (
            <div className={`${card} flex w-full items-center gap-3 px-4 py-3.5`}>
              <span className="ari-status" data-status="error" aria-hidden="true" />
              <p role="alert" className="min-w-0 flex-1 text-[13px] leading-5 text-fg">
                Could not check {failedChecks.join(' and ')}. Retry, or review your setup in
                Settings.
              </p>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => {
                  if (providers.state.status === 'error') providers.retry()
                  if (endpoints.state.status === 'error') endpoints.retry()
                }}
              >
                Retry setup checks
              </Button>
            </div>
          ) : null}

          {/* Detected agents list */}
          {clis.length > 0 ? (
            <div className={`${card} w-full`}>
              <p className={`px-4 pb-1.5 pt-3 ${sectionLabel}`}>Detected local agents</p>
              <ul>
                {clis.map((cli) => (
                  <li
                    key={cli.kind}
                    className="flex h-9 items-center gap-2.5 border-t border-border px-4 text-[13.5px]"
                    title={
                      cli.installed
                        ? `${cli.label}${cli.version ? ` ${cli.version}` : ''}${
                            cli.authenticated ? ' · signed in' : ''
                          }`
                        : `${cli.label} not installed`
                    }
                  >
                    {cli.installed ? (
                      <span
                        className="ari-status"
                        data-status={cli.authenticated ? 'done' : 'attention'}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        cli.installed ? 'text-fg' : 'text-fg-subtle'
                      }`}
                    >
                      {cli.label}
                    </span>
                    {cli.installed && cli.version ? (
                      <span className="shrink-0 text-xs text-fg-subtle" aria-hidden="true">
                        {cli.version}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {needsSetup ? (
            <form
              onSubmit={(e) => void connect(e)}
              className={`${card} flex w-full flex-col gap-3 p-4`}
            >
              <div>
                <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
                  <PlugZap
                    size={16}
                    strokeWidth={1.7}
                    className="shrink-0 text-fg-subtle"
                    aria-hidden="true"
                  />
                  Connect a model to begin
                </h2>
                <p className="mt-1 text-[13px] leading-5 text-fg-subtle">
                  Save an OpenAI-compatible endpoint to use with Ari Core. You can also install a
                  coding agent and check your setup in Settings.
                </p>
              </div>
              <Input
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="Base URL · https://api.openai.com/v1"
                autoComplete="off"
                spellCheck={false}
                aria-label="Base URL"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder="Model · gpt-4o-mini"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Model id"
                />
                <Input
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder="API key · optional"
                  type="password"
                  autoComplete="off"
                  aria-label="API key"
                />
              </div>
              {formError != null ? (
                <p role="alert" className="text-[13px] text-danger">
                  {formError}
                </p>
              ) : null}
              <button
                ref={connectButtonRef}
                type="submit"
                disabled={saving || startPending}
                className={`${outlineButton} self-end`}
              >
                {saving || startPending ? (
                  <span className="ari-status" data-status="working" aria-hidden="true" />
                ) : null}
                {startPending
                  ? 'Starting session…'
                  : alreadySaved
                    ? 'Choose project'
                    : 'Save and choose project'}
              </button>
            </form>
          ) : null}

          {/* Keyboard hints */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-fg-subtle">
            {KEYBOARD_HINTS.map(([keys, label]) => (
              <span key={keys} className="flex items-center gap-1.5">
                <kbd className="font-mono text-[11px] text-fg-muted">{keys}</kbd>
                <span>{label}</span>
              </span>
            ))}
          </div>
        </motion.div>
        <div className="min-h-10 flex-[3]" aria-hidden="true" />
      </div>
    </div>
  )
}

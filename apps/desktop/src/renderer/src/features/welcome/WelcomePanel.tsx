import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { motion } from 'motion/react'
import { ArrowRight, Check, Loader2, PlugZap } from 'lucide-react'
import { useToast } from '@ari/ui/toast'
import { transitions } from '@ari/ui/motion'
import { rpc } from '../../lib/rpc'

interface Detection {
  kind: string
  binaryPath: string | null
  version: string | null
  authStatus: string
}

const CLI_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok Build',
  pi: 'Pi',
  hermes: 'Hermes',
}

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
 */
export function WelcomePanel({
  onCreateSession,
  onConnect,
}: {
  onCreateSession: () => void
  onConnect: (endpointId: string) => void
}) {
  const { toast } = useToast()
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [hasEndpoints, setHasEndpoints] = useState<boolean | null>(null)
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then(setDetections)
      .catch(() => setDetections([]))
    void rpc
      .invoke('endpoints.list')
      .then((list) => setHasEndpoints(list.length > 0))
      .catch(() => setHasEndpoints(false))
  }, [])

  const clis = useMemo(
    () =>
      (detections ?? [])
        .filter((d) => d.kind !== 'ari-core')
        .map((d) => ({
          kind: d.kind,
          label: CLI_LABELS[d.kind] ?? d.kind,
          installed: d.binaryPath !== null,
          version: d.version,
          authenticated: d.authStatus === 'authenticated',
        })),
    [detections],
  )
  const anyCliInstalled = clis.some((c) => c.installed)
  const needsSetup =
    detections !== null && hasEndpoints !== null && !anyCliInstalled && !hasEndpoints

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, '')
    const model = form.model.trim()
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      setFormError('Enter an http(s) base URL, e.g. https://api.openai.com/v1')
      return
    }
    if (model === '') {
      setFormError('Enter a model id, e.g. gpt-4o-mini.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const saved = await rpc.invoke('endpoints.upsert', {
        id: createId(),
        name: hostLabel(baseUrl),
        baseUrl,
        flavor: 'openai-chat',
        model,
        apiKey: form.apiKey.trim() === '' ? null : form.apiKey.trim(),
        headers: {},
      })
      toast({ title: 'Model connected', description: `${saved.name} · ${model}`, tone: 'success' })
      onConnect(saved.id)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.fadeUp}
        className="flex w-full max-w-md flex-col gap-6"
      >
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Ari</h1>
          <p className="text-sm text-fg-muted">
            One surface for every coding agent on your machine — chat, steer, review diffs, run
            terminals.
          </p>
        </div>

        <button
          type="button"
          onClick={onCreateSession}
          className="group flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-fg-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          Start a session
          <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
        </button>

        {clis.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-center text-2xs uppercase tracking-widest text-fg-subtle">
              Detected agents
            </p>
            <ul className="grid grid-cols-2 gap-1.5">
              {clis.map((cli) => (
                <li
                  key={cli.kind}
                  className={`flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs ${
                    cli.installed ? 'text-fg-muted' : 'text-fg-subtle opacity-60'
                  }`}
                  title={
                    cli.installed
                      ? `${cli.label}${cli.version ? ` ${cli.version}` : ''}${
                          cli.authenticated ? ' · signed in' : ''
                        }`
                      : `${cli.label} not installed`
                  }
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      cli.installed && cli.authenticated
                        ? 'bg-success'
                        : cli.installed
                          ? 'bg-warning'
                          : 'bg-surface-3'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate">{cli.label}</span>
                  {cli.installed ? (
                    cli.authenticated ? (
                      <Check size={12} className="shrink-0 text-success" />
                    ) : null
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {needsSetup ? (
          <form
            onSubmit={(e) => void connect(e)}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4"
          >
            <div className="flex items-center gap-2">
              <PlugZap size={14} className="text-accent" />
              <h2 className="text-sm font-medium text-fg">Connect a model to begin</h2>
            </div>
            <p className="text-xs leading-relaxed text-fg-muted">
              Ari works out of the box with your installed CLIs above — or point it at any
              OpenAI-compatible API (OpenAI, OpenRouter, LM Studio, Ollama via OpenAI mode).
            </p>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="Base URL · https://api.openai.com/v1"
              autoComplete="off"
              spellCheck={false}
              aria-label="Base URL"
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="Model · gpt-4o-mini"
                autoComplete="off"
                spellCheck={false}
                aria-label="Model id"
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              />
              <input
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="API key · optional"
                type="password"
                autoComplete="off"
                aria-label="API key"
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              />
            </div>
            {formError != null ? (
              <p role="alert" className="text-xs text-danger">
                {formError}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={saving}
              className="flex items-center justify-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs font-medium text-fg transition-colors hover:bg-surface-3 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              Connect and start chatting
            </button>
          </form>
        ) : null}

        <p className="text-center text-2xs text-fg-subtle">
          Keys are stored encrypted on this machine only. CLIs keep their own sign-in state; Ari
          never touches their credentials.
        </p>
      </motion.div>
    </div>
  )
}

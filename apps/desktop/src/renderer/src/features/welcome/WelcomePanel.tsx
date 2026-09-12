import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { motion } from 'motion/react'
import {
  ArrowRight,
  Check,
  GitBranch,
  Layers,
  Loader2,
  PlugZap,
  Search,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { useToast } from '@ari/ui/toast'
import { transitions } from '@ari/ui/motion'
import { rpc } from '../../lib/rpc'
import { anchorBelow, type MenuAnchor } from '../../shell/ContextMenu'

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
 *
 * Starting a session needs a project, so both session entry points hand their
 * anchor to App, which opens the project picker under the button that was
 * pressed. With no projects yet the button instead says what to do about it.
 */
export function WelcomePanel({
  hasProjects,
  onCreateSession,
  onConnect,
}: {
  hasProjects: boolean
  onCreateSession: (anchor: MenuAnchor) => void
  onConnect: (endpointId: string, anchor: MenuAnchor) => void
}) {
  const { toast } = useToast()
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [hasEndpoints, setHasEndpoints] = useState<boolean | null>(null)
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  /** The connect button, so the session's project picker opens beneath it. */
  const connectButtonRef = useRef<HTMLButtonElement>(null)

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
      const trigger = connectButtonRef.current
      onConnect(saved.id, trigger ? anchorBelow(trigger) : { x: 24, y: 88 })
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  const PROMPT_SUGGESTIONS = [
    {
      title: 'Explain architecture',
      desc: 'Map module boundaries and data flow',
      icon: Layers,
    },
    {
      title: 'Audit git changes',
      desc: 'Review modified files and diffs',
      icon: GitBranch,
    },
    {
      title: 'Run test suite',
      desc: 'Execute tests and inspect regressions',
      icon: Terminal,
    },
    {
      title: 'Find dead code',
      desc: 'Scan for unused exports and patterns',
      icon: Search,
    },
  ]

  return (
    <div className="ari-scroll relative flex h-full items-center justify-center overflow-y-auto p-6">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-80 w-80 rounded-full bg-accent/10 blur-[100px]" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.fadeUp}
        className="relative z-10 flex w-full max-w-lg flex-col gap-6"
      >
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-[28px] font-semibold tracking-[-0.035em] text-fg">
            Ari
            <span aria-hidden="true" className="text-accent">
              .
            </span>
          </h1>
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-fg-muted">
            One unified surface for every coding agent on your machine — chat, steer, review diffs,
            and drive terminals.
          </p>
        </div>

        {/* Quick prompt action grid */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Quick Actions
            </span>
            <span className="text-2xs text-fg-subtle">Click to start</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {PROMPT_SUGGESTIONS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.title}
                  type="button"
                  onClick={(e) => onCreateSession(anchorBelow(e.currentTarget))}
                  className="group relative flex flex-col items-start gap-1.5 rounded-xl border border-border/80 bg-surface-1/70 p-3 text-left shadow-sm transition-all duration-150 hover:border-accent/50 hover:bg-surface-2 hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  <div className="flex w-full items-center justify-between">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 border border-border/60 text-fg-muted transition-colors group-hover:border-accent/40 group-hover:text-accent">
                      <Icon size={14} />
                    </div>
                    <ArrowRight
                      size={13}
                      className="text-fg-subtle opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 group-hover:text-accent"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-fg group-hover:text-accent transition-colors">
                      {item.title}
                    </p>
                    <p className="text-[11px] text-fg-subtle line-clamp-1">{item.desc}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Primary start button */}
        <button
          type="button"
          onClick={(e) => onCreateSession(anchorBelow(e.currentTarget))}
          className="group flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-fg-on-accent shadow-2 transition-all duration-150 hover:bg-accent-hover active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <Sparkles size={15} />
          <span>{hasProjects ? 'Start a new session' : 'Add a project to start'}</span>
          <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
        </button>

        {/* Detected agents list */}
        {clis.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-surface-1/40 p-3">
            <p className="text-center text-2xs uppercase tracking-widest text-fg-subtle">
              Detected local agents
            </p>
            <ul className="grid grid-cols-2 gap-1.5">
              {clis.map((cli) => (
                <li
                  key={cli.kind}
                  className={`flex items-center gap-2 rounded-lg border border-border/70 bg-surface-0/60 px-2.5 py-1.5 text-xs ${
                    cli.installed ? 'text-fg-muted' : 'text-fg-subtle opacity-50'
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
            className="flex flex-col gap-3 rounded-xl border border-border bg-glass-input p-4"
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
              ref={connectButtonRef}
              type="submit"
              disabled={saving}
              className="flex items-center justify-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs font-medium text-fg transition-colors hover:bg-surface-3 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              Connect and start chatting
            </button>
          </form>
        ) : null}

        {/* Keyboard hints footer */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/80 bg-surface-1 px-1 py-0.5 font-mono text-[10px]">
              Mod+N
            </kbd>
            <span>New session</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/80 bg-surface-1 px-1 py-0.5 font-mono text-[10px]">
              Mod+K
            </kbd>
            <span>Palette</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/80 bg-surface-1 px-1 py-0.5 font-mono text-[10px]">
              @
            </kbd>
            <span>Mention file</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/80 bg-surface-1 px-1 py-0.5 font-mono text-[10px]">
              /
            </kbd>
            <span>Commands</span>
          </span>
        </div>
      </motion.div>
    </div>
  )
}

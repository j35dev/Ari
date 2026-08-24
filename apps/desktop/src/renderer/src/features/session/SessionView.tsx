import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import type { CatalogModelInfo, SessionEventFrame } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { rpc } from '../../lib/rpc'
import { TranscriptView } from '../transcript'
import { Composer, type ComposerSeed } from '../composer/Composer'
import { ModelSelector } from '../composer/ModelSelector'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { QuestionPanel } from '../approvals/QuestionPanel'
import { useSettleNotify } from '../moment'
import { WorkingGlyph } from '../moment'

interface PendingApproval {
  approvalId: string
  toolName: string
  summaryJson: string
}

/** A question the agent is waiting on (drives the QuestionPanel mount). */
interface PendingQuestion {
  inputId: string
  prompt: string
  choicesJson: string | null
}

/**
 * Structural guard for the pending-question journal event. The contracts
 * union gains `input.requested` / `input.responded` together with engine
 * decider support; until then these arrive as unknown-typed stream frames
 * and are narrowed here so the UI is ready the moment they flow.
 */
function asInputRequested(event: JournalEvent): PendingQuestion | null {
  const e = event as {
    type?: unknown
    inputId?: unknown
    prompt?: unknown
    choicesJson?: unknown
  }
  if (e.type !== 'input.requested') return null
  if (typeof e.inputId !== 'string' || typeof e.prompt !== 'string') return null
  return {
    inputId: e.inputId,
    prompt: e.prompt,
    choicesJson: typeof e.choicesJson === 'string' ? e.choicesJson : null,
  }
}

/** Returns the answered question's id for `input.responded` events, else null. */
function respondedInputId(event: JournalEvent): string | null {
  const e = event as { type?: unknown; inputId?: unknown }
  return e.type === 'input.responded' && typeof e.inputId === 'string' ? e.inputId : null
}

/** Per-session telemetry shown under the transcript (latency + token counts). */
interface Telemetry {
  turnCount: number
  lastDurationMs: number | null
  inputTokens: number
  outputTokens: number
  startedAt: number | null
}

const EMPTY_TELEMETRY: Telemetry = {
  turnCount: 0,
  lastDurationMs: null,
  inputTokens: 0,
  outputTokens: 0,
  startedAt: null,
}

function formatTokens(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/**
 * Parses a catalog `contextHint` ("200k", "1M", "32768") into a token count.
 * Returns null when absent or unparseable — the meter then shows the used
 * count without a denominator rather than inventing a window size.
 */
export function contextTokensFromHint(hint: string | undefined): number | null {
  if (!hint) return null
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(hint.trim())
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = match[2]?.toLowerCase() ?? ''
  if (unit === 'k') return Math.round(value * 1000)
  if (unit === 'm') return Math.round(value * 1_000_000)
  return Math.round(value)
}

/** Compact token formatting for the meter chip: 200K, 1M, 12.5K, 999. */
export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) {
    const k = n / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`
  }
  return String(n)
}

const METER_WARN_PCT = 75
const METER_DANGER_PCT = 90

/**
 * Context-window meter for the telemetry strip: a slim fill bar plus
 * `used / window` tokens. Without a known window only the used count shows.
 */
export function ContextMeter({
  used,
  contextWindow,
}: {
  used: number
  contextWindow: number | null
}) {
  const pct =
    contextWindow !== null && contextWindow > 0
      ? Math.min(100, Math.round((used / contextWindow) * 100))
      : null
  const tone =
    pct !== null && pct >= METER_DANGER_PCT
      ? 'bg-danger'
      : pct !== null && pct >= METER_WARN_PCT
        ? 'bg-warning'
        : 'bg-accent'
  return (
    <span
      className="flex items-center gap-1.5"
      title={
        contextWindow !== null
          ? `Context: ${formatCompactTokens(used)} of ${formatCompactTokens(contextWindow)} tokens (${pct}%)`
          : `Total tokens: ${formatCompactTokens(used)}`
      }
    >
      {contextWindow !== null ? (
        <span aria-hidden="true" className="h-1 w-9 overflow-hidden rounded-full bg-surface-2">
          <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </span>
      ) : null}
      <span aria-label={`Token usage: ${formatCompactTokens(used)}${contextWindow !== null ? ` of ${formatCompactTokens(contextWindow)}` : ''}`}>
        {formatCompactTokens(used)}
        {contextWindow !== null ? ` / ${formatCompactTokens(contextWindow)}` : ''}
      </span>
    </span>
  )
}

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
}

/**
 * Binds one session's journal to the transcript and composer. The events
 * subscription is established before any state load: history arrives as a
 * journal replay through the same stream live events use, so there is exactly
 * one fold path and no load/replay race.
 */
export function SessionView({
  sessionId,
  defaults,
  onDefaultsChange,
}: {
  sessionId: string
  defaults: SessionDefaults
  onDefaultsChange: (next: SessionDefaults) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [queued, setQueued] = useState<string[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [turnError, setTurnError] = useState<string | null>(null)
  const [telemetry, setTelemetry] = useState<Telemetry>(EMPTY_TELEMETRY)
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([])
  const [turnDiffs, setTurnDiffs] = useState<Record<string, string>>({})
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null)
  const [catalogModels, setCatalogModels] = useState<
    { kind: string; models: CatalogModelInfo[] }[]
  >([])
  const sessionTitleRef = useRef('Session')
  // Workspace path of the session's project — needed by git.turnDiff. Held in
  // a ref so the stable event applier can read it without re-subscribing.
  const projectPathRef = useRef<string | null>(null)
  const fetchedTurnIdsRef = useRef(new Set<string>())
  const queuedDiffTurnIdsRef = useRef(new Set<string>())
  const fetchTurnDiffRef = useRef<(turnId: string) => void>(() => {})
  // Mirrors the engine fold's activeTurnId so locally synthesized assistant
  // messages carry their turn id (drives per-turn diff card placement).
  const activeTurnIdRef = useRef<string | null>(null)
  const notifySettledTurn = useSettleNotify(() => sessionTitleRef.current)
  const notifySettledRef = useRef(notifySettledTurn)
  notifySettledRef.current = notifySettledTurn

  // @file mentions index the first registered workspace; ad-hoc sessions have none.
  // Model catalogs feed the context-window meter's denominator.
  useEffect(() => {
    void rpc
      .invoke('project.list')
      .then(async (projects) => {
        const first = projects[0]
        if (!first) return { paths: [] }
        return rpc.invoke('files.index', { projectId: first.id })
      })
      .then((r) => setFileSuggestions(r.paths))
      .catch(() => undefined)
    void rpc
      .invoke('providers.models')
      .then(setCatalogModels)
      .catch(() => undefined)
  }, [])

  // Window size for the meter: the session model's contextHint from the live
  // catalog, when the catalog carries one. Absent → used-count-only chip.
  const contextWindow = useMemo(() => {
    const row = catalogModels.find((r) => r.kind === defaults.driverKind)
    const model = row?.models.find((m) => m.id === defaults.modelId)
    return contextTokensFromHint(model?.contextHint)
  }, [catalogModels, defaults.driverKind, defaults.modelId])

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setLoading(true)
    setRunning(false)
    setQueued([])
    setApprovals([])
    setPendingQuestion(null)
    setTurnError(null)
    setTelemetry(EMPTY_TELEMETRY)
    setTurnDiffs({})
    projectPathRef.current = null
    fetchedTurnIdsRef.current = new Set()
    queuedDiffTurnIdsRef.current = new Set()
    activeTurnIdRef.current = null

    const unsubscribe = rpc.subscribe('session.events', { sessionId }, (payload) => {
      const frame = payload as SessionEventFrame
      if (frame.sessionId !== sessionId) return
      applyEvent(frame.event as JournalEvent)
    })

    // Per-turn diff cards (M18.1): after a turn settles, query its checkpoint
    // diff once. Fire-and-forget — streaming is never blocked; null/empty or
    // failed queries simply render no card. Turns that settle before the
    // workspace path resolves (journal replay) queue and flush on resolve.
    const fetchTurnDiff = (turnId: string): void => {
      if (fetchedTurnIdsRef.current.has(turnId)) return
      const path = projectPathRef.current
      if (!path) {
        queuedDiffTurnIdsRef.current.add(turnId)
        return
      }
      fetchedTurnIdsRef.current.add(turnId)
      void rpc
        .invoke('git.turnDiff', { path, sessionId, turnId })
        .then((result) => {
          const diffText = result.diffText
          if (!cancelled && typeof diffText === 'string' && diffText.length > 0) {
            setTurnDiffs((prev) => ({ ...prev, [turnId]: diffText }))
          }
        })
        .catch(() => undefined)
    }
    fetchTurnDiffRef.current = fetchTurnDiff

    // Metadata only — message history comes exclusively from the replayed
    // stream above, so this can never clobber or duplicate it.
    void rpc
      .invoke('session.load', { sessionId })
      .then(async (model) => {
        if (cancelled || !model) return
        const m = model as {
          session: Session
          activeTurnId: string | null
        }
        if (m.session.title.trim().length > 0) sessionTitleRef.current = m.session.title
        setRunning(m.activeTurnId !== null)
        onDefaultsChange({
          driverKind: m.session.driverKind,
          modelId: m.session.modelId,
          permissionMode: m.session.permissionMode,
        })
        const projects = await rpc.invoke('project.list').catch(() => [])
        if (cancelled) return
        projectPathRef.current = projects.find((p) => p.id === m.session.projectId)?.path ?? null
        const pending = [...queuedDiffTurnIdsRef.current]
        queuedDiffTurnIdsRef.current.clear()
        for (const turnId of pending) fetchTurnDiff(turnId)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  const applyEvent = useCallback(
    (event: JournalEvent) => {
      switch (event.type) {
        case 'user.message.added':
          setMessages((prev) => [...prev, event.message])
          break
        case 'assistant.parts.appended':
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === event.messageId)
            if (existing) {
              return prev.map((m) =>
                m.id === event.messageId ? { ...m, parts: [...m.parts, ...event.parts] } : m,
              )
            }
            return [
              ...prev,
              {
                id: event.messageId,
                sessionId: event.sessionId,
                turnId: activeTurnIdRef.current,
                role: 'assistant',
                parts: [...event.parts],
                createdAt: event.at,
              },
            ]
          })
          break
        case 'turn.started':
          // A fresh turn supersedes any stale failure banner.
          setTurnError(null)
          setRunning(true)
          activeTurnIdRef.current = event.turnId
          setTelemetry((t) => ({
            ...t,
            turnCount: t.turnCount + 1,
            startedAt: event.at,
          }))
          break
        case 'turn.settled': {
          setRunning(false)
          activeTurnIdRef.current = null
          setTelemetry((t) => ({
            ...t,
            lastDurationMs: t.startedAt !== null ? Math.max(0, event.at - t.startedAt) : t.lastDurationMs,
            startedAt: null,
          }))
          fetchTurnDiffRef.current(event.turnId)
          if (event.stopReason === 'error' && event.errorMessage) {
            setTurnError(event.errorMessage)
            notifySettledRef.current({ error: event.errorMessage })
            // Held, not dropped: queued messages stay visible in the composer
            // so the user can retry after fixing the cause.
            return
          }
          notifySettledRef.current()
          setQueued((prev) => {
            const [next, ...rest] = prev
            if (next) {
              void rpc
                .invoke('command.dispatch', {
                  command: { type: 'turn.start', sessionId: event.sessionId, text: next },
                })
                .catch(() => undefined)
            }
            return rest
          })
          break
        }
        case 'approval.requested':
          setApprovals((prev) => [
            ...prev.filter((a) => a.approvalId !== event.approvalId),
            {
              approvalId: event.approvalId,
              toolName: event.toolName,
              summaryJson: event.summaryJson,
            },
          ])
          break
        case 'approval.responded':
          setApprovals((prev) => prev.filter((a) => a.approvalId !== event.approvalId))
          break
        case 'usage.recorded':
          setTelemetry((t) => ({
            ...t,
            inputTokens: t.inputTokens + (event.inputTokens ?? 0),
            outputTokens: t.outputTokens + (event.outputTokens ?? 0),
          }))
          break
        default: {
          const question = asInputRequested(event)
          if (question) {
            setPendingQuestion(question)
            break
          }
          const respondedId = respondedInputId(event)
          if (respondedId !== null) {
            setPendingQuestion((prev) => (prev?.inputId === respondedId ? null : prev))
          }
        }
      }
    },
    [],
  )

  const handleSend = useCallback(
    (text: string) => {
      if (running) {
        setQueued((prev) => [...prev, text])
        void rpc
          .invoke('command.dispatch', { command: { type: 'message.enqueue', sessionId, text } })
          .catch(() => undefined)
        return
      }
      setTurnError(null)
      void rpc
        .invoke('command.dispatch', { command: { type: 'turn.start', sessionId, text } })
        .catch(() => undefined)
    },
    [sessionId, running],
  )

  const handleStop = useCallback(() => {
    void rpc
      .invoke('command.dispatch', { command: { type: 'turn.interrupt', sessionId } })
      .catch(() => undefined)
  }, [sessionId])

  // M19.4 edit-and-resend: filling the composer (and focusing it) is all an
  // edit does; sending then starts a new turn through the normal send path.
  const handleEditMessage = useCallback((text: string) => {
    setComposerSeed((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  // M19.4 regenerate/retry: the prompt to re-run is the most recent user
  // message's concatenated text parts (null when the transcript has none).
  const lastUserPrompt = useMemo((): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.role !== 'user') continue
      const text = m.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
      return text.length > 0 ? text : null
    }
    return null
  }, [messages])

  // Both regenerate (assistant footer) and retry (error banner) resend the
  // last user prompt as a fresh turn via the normal send path; disabled while
  // a turn runs so it can never enqueue behind itself.
  const resendLastPrompt = useCallback(() => {
    if (running || lastUserPrompt === null) return
    handleSend(lastUserPrompt)
  }, [running, lastUserPrompt, handleSend])

  const respondApproval = useCallback(
    (approvalId: string, decision: 'allow' | 'deny' | 'always-allow') => {
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'approval.respond', sessionId, approvalId, decision },
        })
        .catch(() => undefined)
    },
    [sessionId],
  )

  const respondQuestion = useCallback(
    (value: string) => {
      if (pendingQuestion === null) return
      void rpc
        .invoke('command.dispatch', {
          command: {
            type: 'input.respond',
            sessionId,
            inputId: pendingQuestion.inputId,
            value,
          },
        })
        .then((result) => {
          // Cleared on acceptance; the `input.responded` replay is a no-op.
          // A rejection keeps the panel up so the answer can be retried.
          if (result.accepted) setPendingQuestion(null)
        })
        .catch(() => undefined)
    },
    [sessionId, pendingQuestion],
  )

  const changeModel = useCallback(
    (next: { driverKind: DriverKind; modelId: string | null }) => {
      onDefaultsChange({ ...defaults, ...next })
      void rpc
        .invoke('command.dispatch', {
          command: {
            type: 'session.update',
            sessionId,
            driverKind: next.driverKind,
            modelId: next.modelId,
          },
        })
        .catch(() => undefined)
    },
    [sessionId, onDefaultsChange],
  )

  const changePermissionMode = useCallback(
    (permissionMode: PermissionMode) => {
      onDefaultsChange({ ...defaults, permissionMode })
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'session.update', sessionId, permissionMode },
        })
        .catch(() => undefined)
    },
    [sessionId, onDefaultsChange],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView
          sessionId={sessionId}
          messages={messages}
          loading={loading}
          turnDiffs={turnDiffs}
          onEditUserMessage={handleEditMessage}
          onRegenerate={lastUserPrompt !== null ? resendLastPrompt : undefined}
          regenerateDisabled={running}
        />
      </div>
      <div className="flex h-6 shrink-0 items-center gap-2.5 px-4 font-mono text-2xs tabular-nums text-fg-subtle">
        {telemetry.turnCount > 0 ? (
          <>
            <span>
              {telemetry.turnCount} turn{telemetry.turnCount === 1 ? '' : 's'}
            </span>
            <span aria-hidden>·</span>
            <span>
              last{' '}
              {telemetry.lastDurationMs !== null ? `${(telemetry.lastDurationMs / 1000).toFixed(1)}s` : '—'}
            </span>
            <span aria-hidden>·</span>
            <span title="Input tokens">↑ {formatTokens(telemetry.inputTokens)}</span>
            <span aria-hidden>·</span>
            <span title="Output tokens">↓ {formatTokens(telemetry.outputTokens)}</span>
          </>
        ) : (
          <span>{running ? null : 'no turns yet'}</span>
        )}
        <div className="flex-1" />
        {telemetry.inputTokens + telemetry.outputTokens > 0 ? (
          <ContextMeter
            used={telemetry.inputTokens + telemetry.outputTokens}
            contextWindow={contextWindow}
          />
        ) : null}
        {running ? <WorkingGlyph startedAt={telemetry.startedAt} /> : null}
      </div>
      {pendingQuestion ? (
        <div className="ari-glass-overlay border-t border-border p-3">
          <QuestionPanel
            prompt={pendingQuestion.prompt}
            choicesJson={pendingQuestion.choicesJson}
            onRespond={respondQuestion}
          />
        </div>
      ) : null}
      {approvals.length > 0 ? (
        <div className="ari-glass-overlay max-h-56 space-y-2 overflow-y-auto border-t border-border p-3">
          {approvals.map((a, i) => (
            <ApprovalCard
              key={a.approvalId}
              approvalId={a.approvalId}
              toolName={a.toolName}
              summaryJson={a.summaryJson}
              position={i + 1}
              total={approvals.length}
              onRespond={(decision) =>
                respondApproval(
                  a.approvalId,
                  decision === 'always_allow' ? 'always-allow' : decision,
                )
              }
            />
          ))}
        </div>
      ) : null}
      {turnError ? (
        <div
          role="alert"
          className="mx-3 mb-1 flex items-start gap-2 rounded-md border border-danger-subtle bg-danger-subtle px-3 py-2"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-fg-muted">
            <span className="font-medium text-danger">Turn failed.</span> {turnError}
          </p>
          {lastUserPrompt !== null ? (
            <button
              type="button"
              onClick={resendLastPrompt}
              disabled={running}
              aria-label="Retry last message"
              title="Resend the last message"
              className="shrink-0 rounded-sm border border-danger px-2 py-0.5 text-2xs font-medium text-danger transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50"
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setTurnError(null)}
            className="shrink-0 rounded-sm p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
      <Composer
        onSend={handleSend}
        onStop={handleStop}
        running={running}
        queued={queued}
        seed={composerSeed ?? undefined}
        suggestions={fileSuggestions.length > 0 ? fileSuggestions : undefined}
        leading={
          <>
            <ModelSelector
              driverKind={defaults.driverKind}
              modelId={defaults.modelId}
              onChange={changeModel}
            />
            <PermissionModeChip mode={defaults.permissionMode} onChange={changePermissionMode} />
          </>
        }
      />
    </div>
  )
}

const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask', hint: 'Confirm every edit and command' },
  { value: 'allow-edits', label: 'Edits', hint: 'Auto-approve edits; ask before commands' },
  { value: 'full', label: 'Full auto', hint: 'Approve everything automatically' },
]

const DEFAULT_MODE = PERMISSION_MODES[0] as (typeof PERMISSION_MODES)[number]

/** Inline permission-mode selector (Comet/DSH-style), bottom-left of the composer. */
export function PermissionModeChip({
  mode,
  onChange,
}: {
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
}) {
  const [open, setOpen] = useState(false)
  const current = PERMISSION_MODES.find((m) => m.value === mode) ?? DEFAULT_MODE
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Permission mode: ${current.hint}`}
        aria-label={`Permission mode: ${current.label}`}
        className="flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2.5 text-xs text-fg-muted transition-colors hover:text-fg hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            mode === 'full' ? 'bg-warning' : mode === 'allow-edits' ? 'bg-info' : 'bg-fg-subtle'
          }`}
        />
        <span>{current.label}</span>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-lg border border-border p-1 shadow-2">
            {PERMISSION_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => {
                  onChange(m.value)
                  setOpen(false)
                }}
                className={`flex w-full flex-col rounded-sm px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                  m.value === mode ? 'bg-accent-subtle' : 'hover:bg-surface-2'
                }`}
              >
                <span className="text-xs font-medium text-fg">{m.label}</span>
                <span className="text-2xs text-fg-subtle">{m.hint}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

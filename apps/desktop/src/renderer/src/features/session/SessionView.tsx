import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import type { CatalogModelInfo, SessionEventFrame } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { rpc } from '../../lib/rpc'
import { useToast } from '@ari/ui/toast'
import { TranscriptView } from '../transcript'
import { Composer, type ComposerSeed } from '../composer/Composer'
import { ModelSelector } from '../composer/ModelSelector'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { QuestionPanel } from '../approvals/QuestionPanel'
import { PlanReviewRail } from '../approvals/PlanReviewRail'
import { parseQuestionPayload } from '../approvals/questionnaire'
import { notifyNeedsAttention, useSettleNotify } from '../moment'
import { WorkingGlyph } from '../moment'
import { PlanPanel } from './PlanPanel'
import { TurnErrorBanner } from './TurnErrorBanner'

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
  /** Running total for the ACTIVE turn only (drives the context meter). */
  turnInputTokens: number
  turnOutputTokens: number
}

const EMPTY_TELEMETRY: Telemetry = {
  turnCount: 0,
  lastDurationMs: null,
  inputTokens: 0,
  outputTokens: 0,
  startedAt: null,
  turnInputTokens: 0,
  turnOutputTokens: 0,
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
  /** Harness thought/reasoning level; null leaves the agent's default. */
  effort: string | null
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
  const { toast } = useToast()
  const [telemetry, setTelemetry] = useState<Telemetry>(EMPTY_TELEMETRY)
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([])
  const [turnDiffs, setTurnDiffs] = useState<Record<string, string>>({})
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null)
  const [catalogModels, setCatalogModels] = useState<
    { kind: string; models: CatalogModelInfo[] }[]
  >([])
  // Workspace path + refresh tick driving the plan panel (.ari-todo.json).
  const [planPath, setPlanPath] = useState<string | null>(null)
  const [planNonce, setPlanNonce] = useState(0)
  // Review notes (M21.1): inline diff comments attached to the next message.
  const [reviewNotes, setReviewNotes] = useState<{ path: string; line: number | null; text: string }[]>([])
  const sessionTitleRef = useRef('Session')
  // Workspace path of the session's project — needed by git.turnDiff. Held in
  // a ref so the stable event applier can read it without re-subscribing.
  const projectPathRef = useRef<string | null>(null)
  const fetchedTurnIdsRef = useRef(new Set<string>())
  const queuedDiffTurnIdsRef = useRef(new Set<string>())
  const fetchTurnDiffRef = useRef<(turnId: string) => void>(() => {})
  // Stream ordering guards (M23.12): the journal replay on (re)subscribe races
  // live events, so frames are sequenced by journal `seq` — replayed frames
  // apply immediately, live frames buffer until the replay sentinel, and any
  // seq already applied is dropped. Without this, returning from Settings
  // mid-turn renders every message twice.
  const appliedSeqsRef = useRef<Set<number>>(new Set())
  const replayDoneRef = useRef(false)
  const liveBufferRef = useRef<JournalEvent[]>([])
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

    appliedSeqsRef.current = new Set()
    replayDoneRef.current = false
    liveBufferRef.current = []

    const ingest = (raw: JournalEvent): void => {
      const seq = typeof raw.seq === 'number' ? raw.seq : null
      if (seq !== null) {
        if (appliedSeqsRef.current.has(seq)) return // replay/live overlap
        appliedSeqsRef.current.add(seq)
      }
      applyEvent(raw)
    }

    const unsubscribe = rpc.subscribe('session.events', { sessionId }, (payload) => {
      const frame = payload as SessionEventFrame
      if (frame.sessionId !== sessionId) return
      if (frame.replayDone === true) {
        replayDoneRef.current = true
        const buffered = liveBufferRef.current
        liveBufferRef.current = []
        for (const event of buffered) ingest(event)
        return
      }
      const event = frame.event as JournalEvent
      if (frame.replay === true) {
        // The replay burst is seq-ordered; apply directly.
        ingest(event)
        return
      }
      // Live frame: hold until the replay burst has drained so history and
      // live events interleave in journal order, not arrival order.
      if (!replayDoneRef.current) {
        liveBufferRef.current.push(event)
        return
      }
      ingest(event)
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
          effort: m.session.effort ?? null,
        })
        const projects = await rpc.invoke('project.list').catch(() => [])
        if (cancelled) return
        projectPathRef.current = projects.find((p) => p.id === m.session.projectId)?.path ?? null
        setPlanPath(projectPathRef.current)
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
          setPlanNonce((n) => n + 1)
          if (event.stopReason === 'error' && event.errorMessage) {
            // Raw text is kept: the banner's Details disclosure shows it verbatim.
            setTurnError(event.errorMessage)
            notifySettledRef.current({ error: event.errorMessage })
          } else {
            notifySettledRef.current()
          }
          // Queue continuation is the engine's job now: after a clean settle
          // it dequeues the oldest message and runs it as the next turn.
          // The renderer only mirrors the queue as enqueued/dequeued events
          // arrive, so a steered-away message disappears here immediately.
          break
        }
        case 'message.enqueued':
          setQueued((prev) => [...prev, event.text])
          break
        case 'message.dequeued':
          setQueued((prev) => {
            const idx = prev.indexOf(event.text)
            return idx < 0 ? prev : [...prev.slice(0, idx), ...prev.slice(idx + 1)]
          })
          break
        case 'approval.requested':
          setApprovals((prev) => [
            ...prev.filter((a) => a.approvalId !== event.approvalId),
            {
              approvalId: event.approvalId,
              toolName: event.toolName,
              summaryJson: event.summaryJson,
            },
          ])
          // An approval blocks the turn silently while away — say so.
          notifyNeedsAttention(sessionTitleRef.current, {
            detail: `${event.toolName} approval`,
          })
          break
        case 'approval.responded':
          setApprovals((prev) => prev.filter((a) => a.approvalId !== event.approvalId))
          break
        case 'usage.recorded':
          setTelemetry((t) => ({
            ...t,
            inputTokens: t.inputTokens + (event.inputTokens ?? 0),
            outputTokens: t.outputTokens + (event.outputTokens ?? 0),
            turnInputTokens: t.turnInputTokens + (event.inputTokens ?? 0),
            turnOutputTokens: t.turnOutputTokens + (event.outputTokens ?? 0),
          }))
          break
        default: {
          const question = asInputRequested(event)
          if (question) {
            setPendingQuestion(question)
            notifyNeedsAttention(sessionTitleRef.current, {
              detail: question.prompt.slice(0, 80),
            })
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

  // Command dispatches used to fail silently (.catch(() => undefined)); a
  // rejected dispatch — e.g. the decider declining while a turn is active —
  // now toasts so sending never looks like a no-op.
  const dispatch = useCallback(
    (command: Record<string, unknown>, failureTitle: string): void => {
      void rpc
        .invoke('command.dispatch', { command })
        .catch((err: unknown) => {
          toast({
            title: failureTitle,
            description: err instanceof Error ? err.message : String(err),
            tone: 'danger',
            durationMs: 6000,
          })
        })
    },
    [toast],
  )

  const handleSend = useCallback(
    (text: string) => {
      // Review notes ride along with the next outgoing message, then clear.
      let outgoing = text
      setReviewNotes((notes) => {
        if (notes.length > 0) {
          const block = notes
            .map((n) => `- ${n.path}${n.line !== null ? `:${n.line}` : ''} — ${n.text}`)
            .join('\n')
          outgoing = `Review notes on your changes:\n${block}\n\n${text}`
          return []
        }
        return notes
      })
      if (running) {
        // The engine journals the queue (and dequeues immediately when the
        // transport can steer); the mirrored events update the view here.
        dispatch(
          { type: 'message.enqueue', sessionId, text: outgoing },
          'Couldn’t queue message',
        )
        return
      }
      setTurnError(null)
      dispatch({ type: 'turn.start', sessionId, text: outgoing }, 'Couldn’t send message')
    },
    [sessionId, running, dispatch],
  )

  /** M21.1 review loop: a saved diff line note joins the next message. */
  const handleDiffComment = useCallback((comment: { path: string; line: number | null; text: string }) => {
    setReviewNotes((prev) => [...prev, comment])
  }, [])

  const handleStop = useCallback(() => {
    dispatch({ type: 'turn.interrupt', sessionId }, 'Couldn’t stop the turn')
  }, [sessionId, dispatch])

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
      const current = pendingQuestion
      // Drop the overlay immediately so Submit cannot leave a locked card
      // sitting on screen while the engine journals the answer.
      setPendingQuestion(null)
      void rpc
        .invoke('command.dispatch', {
          command: {
            type: 'input.respond',
            sessionId,
            inputId: current.inputId,
            value,
          },
        })
        .then((result) => {
          if (result.accepted) return
          setPendingQuestion(current)
          toast({
            title: 'Couldn’t send answer',
            description: 'The agent is no longer waiting on this question.',
            tone: 'danger',
            durationMs: 6000,
          })
        })
        .catch((err: unknown) => {
          setPendingQuestion(current)
          toast({
            title: 'Couldn’t send answer',
            description: err instanceof Error ? err.message : String(err),
            tone: 'danger',
            durationMs: 6000,
          })
        })
    },
    [sessionId, pendingQuestion, toast],
  )

  const changeModel = useCallback(
    (next: { driverKind: DriverKind; modelId: string | null }) => {
      // A session that already ran turns stays on its harness: the provider
      // thread (resume id) belongs to that CLI, and switching would fork the
      // context silently. The picker is locked too; this guards other paths.
      if (telemetry.turnCount > 0 && next.driverKind !== defaults.driverKind) return
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
    [sessionId, onDefaultsChange, telemetry.turnCount, defaults],
  )

  const changeEffort = useCallback(
    (effort: string | null) => {
      onDefaultsChange({ ...defaults, effort })
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'session.update', sessionId, effort },
        })
        .catch(() => undefined)
    },
    [sessionId, onDefaultsChange, defaults],
  )

  const changePermissionMode = useCallback(
    (permissionMode: PermissionMode) => {
      // `defaults` must stay in the dep list: omitting it retained a closure
      // over the pre-model-change defaults, so switching modes wrote the stale
      // driverKind/modelId back and the model chip snapped to the CLI default.
      onDefaultsChange({ ...defaults, permissionMode })
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'session.update', sessionId, permissionMode },
        })
        .catch(() => undefined)
    },
    [sessionId, onDefaultsChange, defaults],
  )

  const pendingPlan =
    pendingQuestion === null
      ? null
      : (() => {
          const payload = parseQuestionPayload(pendingQuestion.prompt, pendingQuestion.choicesJson)
          return payload.kind === 'plan-approval' ? payload : null
        })()

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView
          sessionId={sessionId}
          messages={messages}
          loading={loading}
          turnDiffs={turnDiffs}
          onEditUserMessage={handleEditMessage}
          onRegenerate={lastUserPrompt !== null ? resendLastPrompt : undefined}
          regenerateDisabled={running}
          header={<PlanPanel path={planPath} refreshNonce={planNonce} />}
          onDiffComment={handleDiffComment}
          working={running ? <WorkingGlyph startedAt={telemetry.startedAt} /> : null}
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
        {/* Context meter shows the ACTIVE/last turn's footprint, not the
            lifetime total — the window is per-turn, so lifetime totals would
            lie about headroom (DSH token-meter semantics). */}
        {telemetry.turnInputTokens + telemetry.turnOutputTokens > 0 ? (
          <ContextMeter
            used={telemetry.turnInputTokens + telemetry.turnOutputTokens}
            contextWindow={contextWindow}
          />
        ) : null}

      </div>
      {pendingQuestion && pendingPlan === null ? (
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
        <TurnErrorBanner
          message={turnError}
          canRetry={lastUserPrompt !== null}
          retryDisabled={running}
          onRetry={resendLastPrompt}
          onDismiss={() => setTurnError(null)}
        />
      ) : null}
      {reviewNotes.length > 0 ? (
        <div className="mx-4 mb-1 flex flex-wrap items-center gap-1" aria-label="Review notes attached to next message">
          <span className="text-2xs text-fg-subtle">
            {reviewNotes.length} note{reviewNotes.length > 1 ? 's' : ''} with your next message:
          </span>
          {reviewNotes.map((note, i) => (
            <span
              key={`${i}-${note.path}-${note.line ?? 'x'}-${note.text.slice(0, 8)}`}
              className="flex max-w-64 items-center gap-1 rounded-full border border-accent-subtle bg-accent-subtle px-2 py-0.5 text-2xs text-fg-muted"
              title={note.text}
            >
              <span className="min-w-0 truncate font-mono">
                {note.path.split(/[\\/]/).pop()}{note.line !== null ? `:${note.line}` : ''}
              </span>
              <button
                type="button"
                aria-label={`Remove note ${note.text}`}
                onClick={() => setReviewNotes((prev) => prev.filter((_, idx) => idx !== i))}
                className="shrink-0 rounded-full text-fg-subtle transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <X size={10} />
              </button>
            </span>
          ))}
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
              lockedTo={telemetry.turnCount > 0 ? defaults.driverKind : null}
            />
            <EffortChip
              driverKind={defaults.driverKind}
              effort={defaults.effort}
              onChange={changeEffort}
            />
            <PermissionModeChip mode={defaults.permissionMode} onChange={changePermissionMode} />
          </>
        }
      />
      </div>
      {pendingPlan !== null ? (
        <PlanReviewRail
          prompt={pendingPlan.prompt}
          planContent={pendingPlan.planContent}
          onRespond={respondQuestion}
        />
      ) : null}
    </div>
  )
}

interface EffortOption {
  id: string
  label: string
  description?: string
  current?: boolean
}

/**
 * Thought/reasoning chip backed by the harness's own ACP selector
 * (`thought_level`, `effort`, `reasoning_effort`, or a thinking-shaped mode
 * list). Hidden when the agent advertises nothing — we never invent
 * low/medium/high.
 */
export function EffortChip({
  driverKind,
  effort,
  onChange,
}: {
  driverKind: DriverKind
  effort: string | null
  onChange: (effort: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [options, setOptions] = useState<EffortOption[]>([])

  useEffect(() => {
    let cancelled = false
    const apply = (rows: { kind: string; efforts?: EffortOption[] }[]): void => {
      if (cancelled) return
      const row = rows.find((r) => r.kind === driverKind)
      setOptions(row?.efforts ?? [])
      setLoaded(true)
    }
    const load = (): void => {
      void rpc.invoke('providers.models').then(apply).catch(() => {
        if (!cancelled) {
          setOptions([])
          setLoaded(true)
        }
      })
    }
    load()
    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as { type?: string }
      if (frame.type === 'catalog' || frame.type === 'detections') load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [driverKind])

  useEffect(() => {
    if (!loaded || effort === null) return
    if (options.length === 0 || !options.some((o) => o.id === effort)) onChange(null)
  }, [loaded, options, effort, onChange])

  if (options.length === 0) return null

  const selectedId =
    (effort !== null && options.some((o) => o.id === effort) ? effort : null) ??
    options.find((o) => o.current)?.id ??
    options[0]?.id
  const current = options.find((o) => o.id === selectedId) ?? options[0]
  if (current === undefined) return null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={current.description ?? `Effort: ${current.label}`}
        aria-label={`Effort: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface-1 pe-2 ps-2 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span>{current.label}</span>
        <ChevronDown size={11} aria-hidden className={`text-fg-subtle ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-label="Effort"
            className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-52 overflow-hidden rounded-lg border border-border p-1 shadow-2"
          >
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === selectedId}
                onClick={() => {
                  onChange(option.id)
                  setOpen(false)
                }}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2"
              >
                <span className="text-fg">{option.label}</span>
                {option.description ? (
                  <span className="text-2xs text-fg-subtle">{option.description}</span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask', hint: 'Confirm every edit and command' },
  { value: 'allow-edits', label: 'Edits', hint: 'Auto-approve edits; ask before commands' },
  { value: 'full', label: 'Full auto', hint: 'Approve everything automatically' },
]

const DEFAULT_MODE = PERMISSION_MODES[0] as (typeof PERMISSION_MODES)[number]

/** Permission-mode chip in the composer foot. */
export function PermissionModeChip({
  mode,
  onChange,
}: {
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = PERMISSION_MODES.find((m) => m.value === mode) ?? DEFAULT_MODE

  useEffect(() => {
    if (!open) return
    const selected =
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      menuRef.current?.querySelector<HTMLButtonElement>('button')
    selected?.focus()
  }, [open])

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(menuRef.current?.querySelectorAll('button') ?? [])
    const i = buttons.findIndex((b) => b === document.activeElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (buttons.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = buttons[(Math.max(i, 0) + delta + buttons.length) % buttons.length]
      next?.focus()
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Permission mode: ${current.hint}`}
        aria-label={`Permission mode: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface-1 pe-2 ps-2 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            mode === 'full' ? 'bg-warning' : mode === 'allow-edits' ? 'bg-info' : 'bg-fg-subtle'
          }`}
        />
        <span>{current.label}</span>
        <ChevronDown
          size={11}
          aria-hidden
          className={`text-fg-subtle transition-transform duration-[var(--ari-dur-fast)] ease-[var(--ari-ease-out-expo)] motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Permission mode"
            onKeyDown={onMenuKeyDown}
            className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-lg border border-border p-1 shadow-2"
          >
            {PERMISSION_MODES.map((m) => {
              const selected = m.value === mode
              return (
                <button
                  key={m.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(m.value)
                    setOpen(false)
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-fg">{m.label}</span>
                    <span className="block text-2xs text-fg-subtle">{m.hint}</span>
                  </span>
                  {selected ? (
                    <Check size={12} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  ) : null}
                </button>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}

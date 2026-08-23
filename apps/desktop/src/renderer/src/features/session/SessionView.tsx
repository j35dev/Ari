import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { rpc } from '../../lib/rpc'
import { TranscriptView } from '../transcript'
import { Composer } from '../composer/Composer'
import { ModelSelector } from '../composer/ModelSelector'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { useSettleNotify } from '../moment'

interface PendingApproval {
  approvalId: string
  toolName: string
  summaryJson: string
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
  const [turnError, setTurnError] = useState<string | null>(null)
  const [telemetry, setTelemetry] = useState<Telemetry>(EMPTY_TELEMETRY)
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([])
  const sessionTitleRef = useRef('Session')
  const notifySettledTurn = useSettleNotify(() => sessionTitleRef.current)
  const notifySettledRef = useRef(notifySettledTurn)
  notifySettledRef.current = notifySettledTurn

  // @file mentions index the first registered workspace; ad-hoc sessions have none.
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
  }, [])

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setLoading(true)
    setRunning(false)
    setQueued([])
    setApprovals([])
    setTurnError(null)
    setTelemetry(EMPTY_TELEMETRY)

    const unsubscribe = rpc.subscribe('session.events', { sessionId }, (payload) => {
      const frame = payload as SessionEventFrame
      if (frame.sessionId !== sessionId) return
      applyEvent(frame.event as JournalEvent)
    })

    // Metadata only — message history comes exclusively from the replayed
    // stream above, so this can never clobber or duplicate it.
    void rpc
      .invoke('session.load', { sessionId })
      .then((model) => {
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
                turnId: null,
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
          setTelemetry((t) => ({
            ...t,
            turnCount: t.turnCount + 1,
            startedAt: event.at,
          }))
          break
        case 'turn.settled': {
          setRunning(false)
          setTelemetry((t) => ({
            ...t,
            lastDurationMs: t.startedAt !== null ? Math.max(0, event.at - t.startedAt) : t.lastDurationMs,
            startedAt: null,
          }))
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
        default:
          break
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
        <TranscriptView sessionId={sessionId} messages={messages} loading={loading} />
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
          <span>{running ? 'working…' : 'no turns yet'}</span>
        )}
        <div className="flex-1" />
        {running ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-busy" />
            running
          </span>
        ) : null}
      </div>
      {approvals.length > 0 ? (
        <div className="ari-glass-overlay max-h-56 space-y-2 overflow-y-auto border-t border-border p-3">
          {approvals.map((a) => (
            <ApprovalCard
              key={a.approvalId}
              approvalId={a.approvalId}
              toolName={a.toolName}
              summaryJson={a.summaryJson}
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
        className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
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
          <div className="ari-glass-overlay absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-md border border-border p-1 shadow-2">
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

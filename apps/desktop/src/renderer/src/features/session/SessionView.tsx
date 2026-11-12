import {
  Activity,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react'
import { ChildSessionActivity } from './ChildSessionActivity'
import { BackgroundWork, backgroundSummary } from './BackgroundWork'
import { foldBackgroundTask, type BackgroundTask } from '@ari/contracts/background-task'
import { delegatedChildren, type SpawnRecord } from './delegation-view'
import { EffortGlyph, effortLevels } from './effort-level'
import { PICKER, PickerOption, sentenceCase } from './TextPicker'
import { ModeMark } from './mode-mark'
import { useTurnResume } from './use-turn-resume'
import type { SessionActivity } from './session-activity'
import type { DelegatedChild, TurnDiffValue } from '../transcript/types'
import type { ChildTask } from '@ari/contracts/agent-control'
import { ChevronDown, X } from 'lucide-react'
import type { JournalEvent } from '@ari/contracts/events'
import type { AttachmentRef } from '@ari/contracts/attachments'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import { hasProviderContext } from '@ari/contracts/session'
import { canSwitchProvider, isHelmSession } from '@ari/contracts/helm'
import type { ProviderSwitch } from '../transcript/types'
import type { CatalogModelInfo, SessionEventFrame, SessionSummary } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { ApprovalOption } from '@ari/contracts/common'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { resolveOfferedModel } from '@ari/providers/catalogs'
import {
  SessionClientProvider,
  createSessionClient,
  useSessionClient,
  sessionViewKey,
  parseSessionViewKey,
  type SessionScope,
} from './session-client'
import { useToast } from '@ari/ui/toast'
import { Popover } from '@ari/ui/popover'
import { AriaMark } from '@ari/ui/aria-mark'
import { chip, cx, outlineButton } from '../../lib/recipes'
import type { ariaActivity } from '../aria/aria-activity'
import { DitherScene } from '../scene/DitherScene'
import { TranscriptView } from '../transcript'
import {
  Composer,
  type ComposerDraft,
  type ComposerRecovery,
  type ComposerSeed,
  type QueuedMessageView,
} from '../composer/Composer'
import { readSessionDraftText } from '../composer/use-drafts'
import {
  imageIntent,
  MAX_RECOVERIES,
  readSessionDraftIntent,
  updateSessionDraftIntent,
  useSessionDraftIntent,
  type DraftImage,
} from '../composer/draft-recovery-store'
import { ModelSelector } from '../composer/ModelSelector'
import { ApprovalCard, type ApprovalAnswer } from '../approvals/ApprovalCard'
import { QuestionPanel } from '../approvals/QuestionPanel'
import { PlanReviewRail } from '../approvals/PlanReviewRail'
import { parseQuestionPayload } from '../approvals/questionnaire'
import { notifyNeedsAttention, playSettleSound, useSettleNotify } from '../moment'
import { WorkingGlyph } from '../moment'
import { useEngineSettings } from '../settings/useEngineSettings'
import { PlanPanel } from './PlanPanel'
import { ParentSessionLink, paneOriginLink } from './ParentSessionLink'
import { ComposerDock } from './ComposerDock'
import { SessionStatusCapsule } from './SessionStatusCapsule'
import { historyJournal, type HistoryJournal } from './history-journal'
import {
  transcriptStore,
  useTranscriptMessages,
  useTranscriptSelector,
  type TranscriptStore,
} from './transcript-store'
import './session-canvas.css'
import { TurnErrorBanner } from './TurnErrorBanner'
import { ElementChips } from '../browser/ElementChips'
import {
  browserPicksState,
  promptForPicks,
  takeBrowserPicks,
  type BrowserPick,
} from '../browser/browser-picks'
import {
  appendReviewNote,
  formatReviewDrafts,
  readReviewDrafts,
  reviewDraftChipLabel,
  useReviewDrafts,
  writeReviewDrafts,
  type ReviewDraft,
} from '../changes/review-drafts'

interface UnsentMessage extends ComposerRecovery {
  sessionId: string
  notes: readonly ReviewDraft[]
  picks: readonly BrowserPick[]
}

interface PendingApproval {
  approvalId: string
  toolName: string
  summaryJson: string
  /** The choices the provider offered; empty on pre-option journals. */
  options: ApprovalOption[]
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
  /** Session totals. Input counts every token read, cached or not. */
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  startedAt: number | null
  /** The provider's latest context-window reading; null until it sends one. */
  context: { usedTokens: number; windowTokens: number | null } | null
}

const NO_DELEGATIONS: readonly DelegatedChild[] = []
const NO_CHILD_SESSIONS: SessionSummary[] = []

/** The newest user message, which regenerate and retry resend. */
function lastUserOf(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user') return m
  }
  return null
}

/** Prompts typed here, not messages another session or Ari put into this conversation. */
function humanPromptsOf(messages: Message[]): Message[] {
  return messages.filter(
    (m) => m.role === 'user' && (m.origin === undefined || m.origin.kind === 'human'),
  )
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

const isEmpty = (messages: Message[]): boolean => messages.length === 0

/**
 * The transcript, subscribed to the session's message store on its own: a
 * streamed delta re-renders it, not the session view and composer around it.
 * The list is deferred, so a keystroke interrupts a transcript render rather
 * than queueing behind it.
 */
function StoreTranscript({
  store,
  loading,
  ...props
}: { store: TranscriptStore } & Omit<ComponentProps<typeof TranscriptView>, 'messages'>) {
  const latest = useTranscriptMessages(store)
  const messages = useDeferredValue(latest)
  // History that has landed but not rendered yet is still loading: the
  // transcript must not read the stale empty list as an empty session.
  const pending = messages !== latest && messages.length === 0
  return <TranscriptView messages={messages} loading={loading === true || pending} {...props} />
}

const EMPTY_BACKGROUND = { tasks: [] as BackgroundTask[], reporting: false, since: null }
const EMPTY_PROVIDER_CONTEXT = {
  hasMessages: false,
  hasTurns: false,
  providerSessionId: null as string | null,
}
/** How long the rail keeps saying the agent reports back after its last output. */
const REPORTING_LINGER_MS = 4000
/** A load that failed, as one row in the chat column: red dot, message, retry. */
const NOTICE_ROW = 'ari-chat-column mb-2 flex shrink-0 items-center gap-2.5 px-3 text-[13.5px]'

const EMPTY_TELEMETRY: Telemetry = {
  turnCount: 0,
  lastDurationMs: null,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  startedAt: null,
  context: null,
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
export function SessionView(
  props: Parameters<typeof SessionViewContent>[0] & { scope?: SessionScope },
) {
  const inherited = useSessionClient()
  const scope =
    props.scope ??
    (inherited.scope.kind === 'remote'
      ? { ...inherited.scope, sessionId: props.sessionId }
      : parseSessionViewKey(props.sessionId))
  if (!scope) throw new Error('SessionView requires a recognized session scope.')
  if (props.scope && scope.sessionId !== props.sessionId)
    throw new Error('SessionView requires the scoped wire session id.')
  const client = useMemo(
    () => createSessionClient(scope),
    [scope.kind, scope.sessionId, scope.kind === 'remote' ? scope.machineId : null],
  )
  const keyOf = (id: string) =>
    scope.kind === 'remote' ? sessionViewKey({ ...scope, sessionId: id }) : id
  return (
    <SessionClientProvider client={client}>
      <ScopedSessionView
        {...props}
        sessionId={scope.sessionId}
        onOpenSession={props.onOpenSession ? (id) => props.onOpenSession?.(keyOf(id)) : undefined}
        sessionTitle={props.sessionTitle ? (id) => props.sessionTitle?.(keyOf(id)) : undefined}
        activityOf={props.activityOf ? (id) => props.activityOf?.(keyOf(id)) : undefined}
      />
    </SessionClientProvider>
  )
}

function ScopedSessionView(props: Parameters<typeof SessionViewContent>[0]) {
  const client = useSessionClient()
  return <SessionViewContent key={`${client.viewKey}:${client.authorizationEpoch}`} {...props} />
}

function SessionViewContent({
  sessionId,
  defaults,
  onDefaultsChange,
  onPick,
  onOpenSession,
  childSessions = NO_CHILD_SESSIONS,
  activityOf,
  sessionTitle,
  parentSession = null,
  startedByAria = false,
  onOpenAria,
  ariaStatus,
  hidden = false,
  onComposerReady,
}: {
  sessionId: string
  defaults: SessionDefaults
  onDefaultsChange: (next: SessionDefaults) => void
  /** A model or reasoning level the user chose here, for new sessions to start from. */
  onPick?: (pick: Partial<Pick<SessionDefaults, 'driverKind' | 'modelId' | 'effort'>>) => void
  onOpenSession?: (id: string) => void
  childSessions?: SessionSummary[]
  activityOf?: (id: string) => SessionActivity | undefined
  /** Current title of any session, for naming the sender of a relayed message. */
  sessionTitle?: (id: string) => string | undefined
  /** The session that delegated to this one, when it is a child. */
  parentSession?: { id: string; title: string } | null
  startedByAria?: boolean
  onOpenAria?: () => void
  /**
   * What Aria's sessions are doing, for the header of her own chat. Without
   * it the header shows her name alone.
   */
  ariaStatus?: ReturnType<typeof ariaActivity>
  /**
   * Kept mounted behind the pane's current session. The journal subscription
   * stays live so the view is current when it returns, but its subtree's
   * effects pause and its cues stay quiet: an unseen session makes no sound,
   * as it did when switching away unmounted it.
   */
  hidden?: boolean
  /** Used only by the shell's explicit session-start handoff. */
  onComposerReady?: (input: HTMLTextAreaElement) => void
}) {
  const rpc = useSessionClient()
  const viewKey = rpc.viewKey
  const remote = rpc.scope.kind === 'remote'
  const [hostCatalog, setHostCatalog] = useState<RemoteModelCatalog | null>(null)
  useEffect(() => {
    if (rpc.scope.kind !== 'remote' || rpc.readOnly) return
    let cancelled = false
    void import('./session-client')
      .then(({ readHostModelCatalog }) =>
        readHostModelCatalog(rpc.scope.kind === 'remote' ? rpc.scope.machineId : ''),
      )
      .then((catalog) => {
        if (!cancelled) setHostCatalog(catalog)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [rpc, rpc.availability])
  const [, setReceiptRevision] = useState(0)
  let receiptPending = false
  let receiptError: string | null = null
  try {
    receiptPending = rpc.receipt() !== null
  } catch (error) {
    receiptPending = true
    receiptError = error instanceof Error ? error.message : 'Submission evidence is unreadable.'
  }
  const hostBlocked = remote && (rpc.readOnly || receiptPending)
  const actionReason = (operation: string): string | null =>
    remote
      ? receiptPending
        ? 'Check the original submission receipt before another action.'
        : rpc.readOnly
          ? (rpc.capabilityReason('events.desktop.subscribe') ?? 'This host session is read-only.')
          : rpc.capabilityReason(operation)
      : null
  const updateReason = actionReason('session.update')
  const store = useMemo(() => transcriptStore(viewKey), [viewKey])
  const turnsInView = useMemo(() => new Set<string>(), [sessionId])
  const [historyReadySession, setHistoryReadySession] = useState<string | null>(null)
  const [metadataReadySession, setMetadataReadySession] = useState<string | null>(null)
  const [workspaceInfo, setWorkspaceInfo] = useState<{
    sessionId: string
    workspace: Session['workspace']
  } | null>(null)
  const managedWorkspace =
    workspaceInfo?.sessionId === sessionId && workspaceInfo.workspace?.kind === 'managed-worktree'
      ? workspaceInfo.workspace
      : null
  const [historyFailureSession, setHistoryFailureSession] = useState<string | null>(null)
  const [historyRetrying, setHistoryRetrying] = useState(false)
  const [metadataFailureSession, setMetadataFailureSession] = useState<string | null>(null)
  const [metadataRetrying, setMetadataRetrying] = useState(false)
  const retryHistoryRef = useRef<() => void>(() => {})
  const retryMetadataRef = useRef<() => void>(() => {})
  // History is loading until its replay has been applied, so the transcript
  // never paints an empty state, or animates history in, while it is in flight.
  const loading = historyReadySession !== sessionId
  const historyJournalRef = useRef<HistoryJournal | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [running, setRunning] = useState(false)
  const sendReason = actionReason(running ? 'session.queue' : 'session.prompt')
  const [providerSwitchable, setProviderSwitchable] = useState(false)
  // Aria's own chat (the helm project): it wears her identity, not a session's.
  const [helm, setHelm] = useState(false)
  const [providerSwitches, setProviderSwitches] = useState<ProviderSwitch[]>([])
  const [providerContext, setProviderContext] = useState(EMPTY_PROVIDER_CONTEXT)
  const providerLocked = !providerSwitchable && hasProviderContext(providerContext)
  const [queued, setQueued] = useState<QueuedMessageView[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [turnError, setTurnError] = useState<string | null>(null)
  const errorTurnIdRef = useRef<string | null>(null)
  const dismissedErrorTurnIdRef = useRef<string | null>(null)
  const { toast } = useToast()
  const [telemetry, setTelemetry] = useState<Telemetry>(EMPTY_TELEMETRY)
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([])
  const [turnDiffs, setTurnDiffs] = useState<Record<string, TurnDiffValue>>({})
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null)
  const draftIntent = useSessionDraftIntent(viewKey)
  const sendPending = draftIntent.pendingId !== undefined || hostBlocked || sendReason !== null
  const viewMountedRef = useRef(true)
  useEffect(() => {
    viewMountedRef.current = true
    return () => {
      viewMountedRef.current = false
    }
  }, [])
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const [catalogModels, setCatalogModels] = useState<
    { kind: string; models: CatalogModelInfo[] }[]
  >([])
  // Refresh tick driving the plan panel (per-session
  // `.ari-todo-<sessionId>.json`, keyed by this view's session id).
  const [planNonce, setPlanNonce] = useState(0)
  // Review notes (M21.1): inline diff comments and review ranges attached to
  // the next message. They live in session storage so a reload keeps them.
  const reviewNotes = useReviewDrafts(viewKey)
  const elementPicks = draftIntent.picks
  const sessionTitleRef = useRef('Session')
  const fetchedTurnIdsRef = useRef(new Set<string>())
  const fetchTurnDiffRef = useRef<(turnId: string) => void>(() => {})
  const settledTurnIdsRef = useRef(new Set<string>())
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
  // Delegated children: where each was spawned in this transcript, and the
  // latest snapshot of how each is doing. The ref tracks the newest message
  // part in journal order so a spawn can be anchored without reading state.
  const [spawns, setSpawns] = useState<SpawnRecord[]>([])
  // Null until the first snapshot lands: a card drawn before it would have
  // to guess, and reads as idle for the moment it takes to arrive.
  const [tasks, setTasks] = useState<ChildTask[] | null>(null)
  const stopChildrenKeyRef = useRef<string | null>(null)
  const [stoppingChildren, setStoppingChildren] = useState(false)
  // The agent harness's own sub-agents and background shells, and whether it
  // is reporting back between turns right now (output with no turn live).
  const [background, setBackground] = useState<{
    tasks: BackgroundTask[]
    reporting: boolean
    since: number | null
  }>(EMPTY_BACKGROUND)
  const reportingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPartRef = useRef<{ messageId: string; parts: number } | null>(null)
  const refreshTasksRef = useRef<() => void>(() => {})
  const notifySettledTurn = useSettleNotify(() => sessionTitleRef.current)
  const notifySettledRef = useRef(notifySettledTurn)
  notifySettledRef.current = notifySettledTurn
  // Settle chime toggle; null until settings load (defaults on). Ref so the
  // stable event applier reads it without re-subscribing.
  const { settings: engineSettings } = useEngineSettings()
  const settleSoundRef = useRef(true)
  settleSoundRef.current = engineSettings?.notifications.settleSound ?? true
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults
  const modelPicksRef = useRef({
    sequence: 0,
    pending: 0,
    confirmed: {
      driverKind: defaults.driverKind,
      modelId: defaults.modelId,
      effort: defaults.effort,
    },
  })
  const effortRevisionRef = useRef(0)
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const onDefaultsChangeRef = useRef(onDefaultsChange)
  onDefaultsChangeRef.current = onDefaultsChange

  // @file mentions index the first registered workspace; ad-hoc sessions have none.
  // Model catalogs feed the context-window meter's denominator.
  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('files.index', { sessionId })
      .then((r) => {
        if (!cancelled) setFileSuggestions(r.paths)
      })
      .catch(() => undefined)
    void rpc
      .invoke('providers.models')
      .then((models) => {
        if (!cancelled) setCatalogModels(models)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId, rpc, rpc.availability])

  // Window size for the meter: what the provider measured, else the session
  // model's contextHint from the live catalog. Neither → used-count-only chip.
  const catalogWindow = useMemo(() => {
    const row = catalogModels.find((r) => r.kind === defaults.driverKind)
    const id =
      defaults.modelId === null || row === undefined
        ? null
        : resolveOfferedModel(defaults.modelId, row.models)
    const model = row?.models.find((m) => m.id === id)
    return contextTokensFromHint(model?.contextHint)
  }, [catalogModels, defaults.driverKind, defaults.modelId])
  const contextWindow = telemetry.context?.windowTokens ?? catalogWindow
  const modelLabel = useCallback(
    (kind: DriverKind, id: string) =>
      catalogModels
        .find((row) => row.kind === kind)
        ?.models.find((model) => model.id === id || model.aliases?.includes(id))?.label,
    [catalogModels],
  )

  useEffect(() => {
    let cancelled = false
    const history = historyJournal(store)
    history.begin()
    historyJournalRef.current = history
    setHistoryReadySession(null)
    setHistoryFailureSession(null)
    setHistoryRetrying(false)
    setMetadataFailureSession(null)
    setMetadataRetrying(false)
    setRunning(false)
    setProviderSwitchable(false)
    setHelm(false)
    setProviderSwitches([])
    setProviderContext(EMPTY_PROVIDER_CONTEXT)
    modelPicksRef.current = {
      sequence: 0,
      pending: 0,
      confirmed: {
        driverKind: defaultsRef.current.driverKind,
        modelId: defaultsRef.current.modelId,
        effort: defaultsRef.current.effort,
      },
    }
    setQueued([])
    setApprovals([])
    setPendingQuestion(null)
    setTurnError(null)
    errorTurnIdRef.current = null
    dismissedErrorTurnIdRef.current = null
    setTelemetry(EMPTY_TELEMETRY)
    setTurnDiffs({})
    setSpawns([])
    setTasks(null)
    stopChildrenKeyRef.current = null
    setStoppingChildren(false)
    setBackground(EMPTY_BACKGROUND)
    if (reportingTimerRef.current !== null) clearTimeout(reportingTimerRef.current)
    reportingTimerRef.current = null
    lastPartRef.current = null
    fetchedTurnIdsRef.current = new Set()
    settledTurnIdsRef.current = new Set()
    activeTurnIdRef.current = null

    // Task snapshots trail the journal: a burst of child events (replay, or
    // siblings settling together) coalesces into one fetch.
    let tasksTimer: ReturnType<typeof setTimeout> | null = null
    let taskRequest = 0
    refreshTasksRef.current = () => {
      if (tasksTimer !== null) return
      tasksTimer = setTimeout(() => {
        tasksTimer = null
        const request = ++taskRequest
        void rpc
          .invoke('session.tasks', { sessionId })
          .then((next) => {
            if (!cancelled && request === taskRequest) setTasks(next)
          })
          // Without a snapshot the cards still show, from live activity alone.
          .catch(() => {
            if (remote) return
            if (!cancelled && request === taskRequest) setTasks((prev) => prev ?? [])
          })
      }, 200)
    }

    appliedSeqsRef.current = new Set()
    replayDoneRef.current = false
    liveBufferRef.current = []

    const ingest = (raw: JournalEvent, live: boolean, recovering = false): void => {
      if (!raw || raw.sessionId !== sessionId) return
      const seq = typeof raw.seq === 'number' ? raw.seq : null
      if (seq !== null) {
        if (appliedSeqsRef.current.has(seq)) return // replay/live overlap
        appliedSeqsRef.current.add(seq)
      }
      history.add(raw)
      // Retry folds controls once in journal order at its terminal. Applying a
      // recovered older request now could overwrite a newer live answer.
      if (!recovering || raw.type.startsWith('child.session.')) applyEvent(raw, live)
      if (raw.type.startsWith('orchestration.')) refreshTasksRef.current()
    }
    // One transcript update per IPC frame, and live deltas at most once per
    // animation frame: a burst of flushes (several panes streaming, or a
    // batched stream frame) paints once.
    let publishFrame: number | null = null
    const publishMessages = (): void => {
      if (publishFrame !== null) cancelAnimationFrame(publishFrame)
      publishFrame = null
      history.publish()
    }
    const publishSoon = (): void => {
      publishFrame ??= requestAnimationFrame(() => {
        publishFrame = null
        history.publish()
      })
    }

    let generation = 0
    let unsubscribe: (() => void) | null = null
    let retiring: { attempt: number; stop: () => void } | null = null
    let continuedReplay = false
    const subscribeHistory = (): void => {
      if (generation > 0 && !replayDoneRef.current) return
      const attempt = ++generation
      if (unsubscribe) {
        // Keep the previous live source until the new subscription's terminal.
        // Otherwise async unsubscribe/subscribe IPC leaves a gap on failed reads.
        retiring = { attempt: attempt - 1, stop: unsubscribe }
        publishMessages()
      }
      replayDoneRef.current = false
      // A retry starts only after a terminal drained the previous buffer.
      setHistoryRetrying(true)
      unsubscribe = rpc.subscribe('session.events', { sessionId }, (payload) => {
        if (cancelled) return
        const frame = payload as SessionEventFrame & { seq?: number; replayStart?: boolean }
        if (frame.sessionId !== sessionId) return
        if (
          attempt !== generation &&
          (retiring?.attempt !== attempt || frame.replay === true || frame.replayDone === true)
        )
          return
        if (frame.replayStart === true) {
          if (!replayDoneRef.current) return
          continuedReplay = true
          replayDoneRef.current = false
          appliedSeqsRef.current = new Set()
          liveBufferRef.current = []
          history.begin()
          setHistoryRetrying(true)
          return
        }
        if (frame.replayDone === true) {
          if (replayDoneRef.current) return
          replayDoneRef.current = true
          retiring?.stop()
          retiring = null
          setHistoryReadySession(sessionId)
          setHistoryRetrying(false)
          setHistoryFailureSession(frame.replayOutcome === 'incomplete' ? sessionId : null)
          const buffered = liveBufferRef.current
          liveBufferRef.current = []
          const ordered = buffered.sort((a, b) => a.seq - b.seq)
          const afterBarrier =
            remote && frame.seq !== undefined
              ? ordered.filter((event) => event.seq > frame.seq!)
              : []
          for (const event of ordered) if (!afterBarrier.includes(event)) ingest(event, true)
          history.finish(
            frame.replayOutcome !== 'incomplete',
            (frame as SessionEventFrame & { replayMode?: 'full' | 'resume' }).replayMode,
          )
          const { model, telemetry, settledTurnIds } = history.controls()
          settledTurnIdsRef.current = settledTurnIds
          for (const turnId of turnsInView)
            if (settledTurnIds.has(turnId)) fetchTurnDiffRef.current(turnId)
          // Retry can recover a settlement that never reached the live applier.
          // Derive its banner without replaying notifications or undoing dismissal.
          const failure =
            frame.liveTurnId == null &&
            model.activeTurnId === null &&
            model.lastTurn?.stopReason === 'error'
              ? model.lastTurn
              : null
          errorTurnIdRef.current = failure?.turnId ?? null
          setTurnError(
            failure && failure.turnId !== dismissedErrorTurnIdRef.current
              ? (failure.errorMessage ?? null)
              : null,
          )
          setTelemetry(telemetry)
          setApprovals(model.pendingApprovals)
          setPendingQuestion(model.pendingInputs.at(-1) ?? null)
          if (attempt > 1 || continuedReplay) {
            setQueued(model.queuedMessages)
            setBackground((prev) => ({ ...prev, tasks: model.backgroundTasks ?? [] }))
          }
          // All buffered events predate this runtime boundary. Journaled starts
          // (including a process that died mid-read) cannot resurrect execution.
          if (frame.liveTurnId !== undefined) {
            activeTurnIdRef.current = frame.liveTurnId
            setRunning(frame.liveTurnId !== null)
            if (frame.liveTurnId === null) {
              setPendingQuestion(null)
              setApprovals([])
              setTelemetry((prev) => ({ ...prev, startedAt: null }))
            }
          }
          // Events newer than the host's replay barrier own the current runtime.
          for (const event of afterBarrier) ingest(event, true)
          publishMessages()
          lastPartRef.current = history.lastPart
          return
        }
        if (frame.replay === true) {
          // The burst is seq-ordered but split across bounded frames: each
          // chunk folds and lands before the next one, so a long session
          // paints progressively instead of waiting for one serialization.
          for (const event of (frame.events ?? []) as JournalEvent[])
            ingest(event, false, attempt > 1 || continuedReplay)
          // A retry retains the current transcript until the ordered merge can
          // commit once, rather than rebuilding a long history per old chunk.
          if (attempt === 1 && !continuedReplay) publishMessages()
          return
        }
        const event = frame.event as JournalEvent
        if (!event || event.sessionId !== sessionId) return
        // Live frame: hold until the replay burst has drained so history and
        // live events interleave in journal order, not arrival order.
        if (!replayDoneRef.current) {
          liveBufferRef.current.push(event)
          return
        }
        ingest(event, true)
        // A prompt lands at once; streamed parts wait for the next frame.
        if (event.type === 'assistant.parts.appended') publishSoon()
        else publishMessages()
      })
    }
    retryHistoryRef.current = subscribeHistory
    subscribeHistory()

    // Per-turn diff cards: query once after settle. An empty diff stays silent.
    // A failure stays on screen with its reason so it cannot look like a clean turn.
    const fetchTurnDiff = (turnId: string): void => {
      if (fetchedTurnIdsRef.current.has(turnId)) return
      fetchedTurnIdsRef.current.add(turnId)
      void rpc
        .invoke('git.turnDiff', { sessionId, turnId })
        .then((result) => {
          if (cancelled) return
          const failure = result.error
          if (typeof failure === 'string' && failure.length > 0) {
            setTurnDiffs((prev) => ({ ...prev, [turnId]: { error: failure } }))
            return
          }
          const diffText = result.diffText
          const summary = result.summary
          if (summary && summary.files.length > 0) {
            setTurnDiffs((prev) => ({ ...prev, [turnId]: { summary, sessionId } }))
          } else if (typeof diffText === 'string' && diffText.length > 0) {
            setTurnDiffs((prev) => ({ ...prev, [turnId]: diffText }))
          }
        })
        .catch(() => {
          if (!cancelled) {
            setTurnDiffs((prev) => ({
              ...prev,
              [turnId]: { error: 'Could not load this turn’s diff.' },
            }))
          }
        })
    }
    fetchTurnDiffRef.current = fetchTurnDiff

    // Metadata only — message history comes exclusively from the replayed
    // stream above, so this can never clobber or duplicate it.
    let metadataRequest = 0
    const loadMetadata = (): void => {
      const request = ++metadataRequest
      setMetadataRetrying(true)
      void rpc
        .invoke('session.load', { sessionId })
        .then((model) => {
          if (cancelled || request !== metadataRequest) return
          if (!model) throw new Error('Session details unavailable')
          const m = model as {
            session: Session
            activeTurnId: string | null
            messages?: Message[]
            lastTurn?: unknown
            providerSessionId?: string | null
            context?: { hasMessages: boolean; hasTurns: boolean; hasProviderContext: boolean }
          }
          if (m.session.title.trim().length > 0) sessionTitleRef.current = m.session.title
          setWorkspaceInfo({ sessionId, workspace: m.session.workspace })
          setMetadataFailureSession(null)
          setProviderSwitchable(canSwitchProvider(m.session))
          setHelm(isHelmSession(m.session))
          setProviderContext((previous) => ({
            hasMessages:
              previous.hasMessages ||
              (m.messages?.length ?? 0) > 0 ||
              m.context?.hasMessages === true,
            hasTurns:
              previous.hasTurns ||
              m.activeTurnId !== null ||
              m.lastTurn != null ||
              m.context?.hasTurns === true,
            providerSessionId: m.providerSessionId ?? previous.providerSessionId,
          }))
          setMetadataReadySession(sessionId)
          onDefaultsChange({
            driverKind: m.session.driverKind,
            modelId: m.session.modelId,
            permissionMode: m.session.permissionMode,
            effort: m.session.effort ?? null,
          })
        })
        .catch(() => {
          if (!cancelled && request === metadataRequest) setMetadataFailureSession(sessionId)
        })
        .finally(() => {
          if (!cancelled && request === metadataRequest) setMetadataRetrying(false)
        })
    }
    retryMetadataRef.current = loadMetadata
    loadMetadata()

    return () => {
      cancelled = true
      generation++
      retryHistoryRef.current = () => {}
      retryMetadataRef.current = () => {}
      if (tasksTimer !== null) clearTimeout(tasksTimer)
      if (reportingTimerRef.current !== null) clearTimeout(reportingTimerRef.current)
      reportingTimerRef.current = null
      refreshTasksRef.current = () => {}
      if (publishFrame !== null) cancelAnimationFrame(publishFrame)
      unsubscribe?.()
      retiring?.stop()
    }
  }, [sessionId, store, turnsInView, rpc, rpc.availability])

  const applyEvent = useCallback((event: JournalEvent, live: boolean) => {
    switch (event.type) {
      case 'session.created':
        setWorkspaceInfo({ sessionId, workspace: event.session.workspace })
        setProviderSwitchable(canSwitchProvider(event.session))
        setHelm(isHelmSession(event.session))
        break
      case 'session.provider.switched':
        setProviderSwitches((prev) => [...prev, event])
        if (live)
          onDefaultsChangeRef.current({
            ...defaultsRef.current,
            driverKind: event.driverKind,
            modelId: event.modelId,
            effort: event.effort,
          })
        break
      case 'child.session.spawned': {
        // The card sits where the spawn happened: after whatever part of the
        // conversation was last on screen when this event was journaled.
        const anchor = lastPartRef.current
        const record: SpawnRecord = {
          sessionId: event.childSessionId,
          title: event.title,
          role: event.role ?? null,
          driverKind: event.driverKind,
          modelId: event.modelId,
          anchor: { messageId: anchor?.messageId ?? null, partIndex: (anchor?.parts ?? 1) - 1 },
          destroyed: false,
          spawnedAt: event.at,
        }
        setSpawns((prev) =>
          prev.some((spawn) => spawn.sessionId === record.sessionId) ? prev : [...prev, record],
        )
        refreshTasksRef.current()
        break
      }
      case 'child.session.destroyed':
        setSpawns((prev) =>
          prev.map((spawn) =>
            spawn.sessionId === event.childSessionId ? { ...spawn, destroyed: true } : spawn,
          ),
        )
        refreshTasksRef.current()
        break
      case 'child.session.settled':
      case 'child.session.stopped':
        refreshTasksRef.current()
        break
      case 'child.session.integrated':
      case 'child.session.acknowledged':
        refreshTasksRef.current()
        break
      case 'user.message.added':
        setProviderContext((previous) =>
          previous.hasMessages ? previous : { ...previous, hasMessages: true },
        )
        lastPartRef.current = historyJournalRef.current?.lastPart ?? null
        break
      case 'assistant.parts.appended': {
        setProviderContext((previous) =>
          previous.hasMessages ? previous : { ...previous, hasMessages: true },
        )
        // Counted per message: a steered user message lands in the middle of
        // a turn, and the assistant message it interrupts keeps growing after.
        lastPartRef.current = historyJournalRef.current?.lastPart ?? null
        // Output with no turn live is the agent reporting back on its own;
        // the rail says so while it streams, and a little after.
        if (live && activeTurnIdRef.current === null) {
          setBackground((prev) => (prev.reporting ? prev : { ...prev, reporting: true }))
          if (reportingTimerRef.current !== null) clearTimeout(reportingTimerRef.current)
          reportingTimerRef.current = setTimeout(() => {
            reportingTimerRef.current = null
            setBackground((prev) => ({ ...prev, reporting: false }))
          }, REPORTING_LINGER_MS)
        }
        break
      }
      case 'background.task.updated':
        refreshTasksRef.current()
        setBackground((prev) => ({
          ...prev,
          tasks: foldBackgroundTask(prev.tasks, event, event.at),
        }))
        break
      case 'turn.started':
        setProviderContext((previous) =>
          previous.hasTurns ? previous : { ...previous, hasTurns: true },
        )
        // A fresh turn supersedes any stale failure banner.
        setTurnError(null)
        errorTurnIdRef.current = null
        if (live) {
          setRunning(true)
          activeTurnIdRef.current = event.turnId
          setBackground((prev) => ({ ...prev, reporting: false, since: event.at }))
        }
        setTelemetry((t) => ({
          ...t,
          turnCount: t.turnCount + 1,
          startedAt: live ? event.at : t.startedAt,
        }))
        break
      case 'turn.settled': {
        // A settled turn owns no live prompts: stopping (or failing) while
        // a question or approval is parked unmounts its card at once, so a
        // later answer can never strand a card no dispatch can satisfy.
        if (live) {
          setRunning(false)
          setPendingQuestion(null)
          setApprovals([])
          activeTurnIdRef.current = null
        }
        setTelemetry((t) => ({
          ...t,
          lastDurationMs:
            t.startedAt !== null ? Math.max(0, event.at - t.startedAt) : t.lastDurationMs,
          startedAt: live ? null : t.startedAt,
        }))
        // History turns query their diff once the transcript scrolls them
        // near view (see handleTurnInView); a session with N past turns would
        // otherwise spawn N git diffs on open.
        settledTurnIdsRef.current.add(event.turnId)
        if (live) fetchTurnDiffRef.current(event.turnId)
        setPlanNonce((n) => n + 1)
        if (event.stopReason === 'error' && event.errorMessage) {
          // Raw text is kept: the banner's Details disclosure shows it verbatim.
          errorTurnIdRef.current = event.turnId
          setTurnError(event.errorMessage)
          if (live && !hiddenRef.current) notifySettledRef.current({ error: event.errorMessage })
        } else if (live && !hiddenRef.current) {
          notifySettledRef.current()
        }
        // Settle chime — live settles only, so remounting a session never
        // replays the cue for turns that finished while it was closed.
        if (live && settleSoundRef.current && !hiddenRef.current) {
          playSettleSound(event.stopReason === 'error' ? 'error' : 'complete')
        }
        // Queue continuation is the engine's job now: after a clean settle
        // it dequeues the oldest message and runs it as the next turn.
        // Steered follow-ups dequeue immediately and arrive as
        // user.message.added so they stay visible in the transcript.
        break
      }
      case 'message.enqueued':
        setQueued((prev) => [
          ...prev,
          {
            text: event.text,
            attachments: event.attachments ?? [],
            ...(event.origin ? { origin: event.origin } : {}),
          },
        ])
        break
      case 'message.dequeued':
        setQueued((prev) => {
          const want = (event.attachments ?? []).map((a) => a.id).join(',')
          const idx = prev.findIndex(
            (q) =>
              q.text === event.text &&
              JSON.stringify(q.origin ?? null) === JSON.stringify(event.origin ?? null) &&
              (event.attachments === undefined ||
                q.attachments.map((a) => a.id).join(',') === want),
          )
          return idx < 0 ? prev : [...prev.slice(0, idx), ...prev.slice(idx + 1)]
        })
        break
      case 'approval.requested':
        // Replayed requests wait for the runtime boundary before becoming
        // actionable; a historical journal alone cannot own an approval.
        if (!live) break
        setApprovals((prev) => [
          ...prev.filter((a) => a.approvalId !== event.approvalId),
          {
            approvalId: event.approvalId,
            toolName: event.toolName,
            summaryJson: event.summaryJson,
            options: event.options,
          },
        ])
        if (!live || hiddenRef.current) break
        // An approval blocks the turn silently while away — say so.
        notifyNeedsAttention(sessionTitleRef.current, {
          detail: `${event.toolName} approval`,
        })
        // Attention cue — live blocks only, so journal replay on remount
        // never replays it. Fires even when focused: the card is visible
        // but the user may be looking away.
        if (live && settleSoundRef.current) {
          playSettleSound('attention')
        }
        break
      case 'approval.responded':
        setApprovals((prev) => prev.filter((a) => a.approvalId !== event.approvalId))
        break
      case 'session.updated':
        // An always-allow answer widens the mode from the engine side. Live
        // only: `session.load` already seeds the chip with the replayed value.
        if (live && event.permissionMode !== undefined) {
          onDefaultsChangeRef.current({
            ...defaultsRef.current,
            permissionMode: event.permissionMode,
          })
        }
        break
      case 'session.ref.observed':
        setProviderContext((previous) => ({ ...previous, providerSessionId: event.ref }))
        break
      case 'usage.recorded':
        setTelemetry((t) => ({
          ...t,
          inputTokens: t.inputTokens + (event.inputTokens ?? 0),
          cachedInputTokens: t.cachedInputTokens + (event.cachedInputTokens ?? 0),
          outputTokens: t.outputTokens + (event.outputTokens ?? 0),
        }))
        break
      case 'context.recorded':
        setTelemetry((t) => ({
          ...t,
          context: {
            usedTokens: event.usedTokens,
            // Mid-turn readings may omit the size; the last one given holds.
            windowTokens: event.windowTokens ?? t.context?.windowTokens ?? null,
          },
        }))
        break
      default: {
        const question = asInputRequested(event)
        if (question) {
          if (!live) break
          setPendingQuestion(question)
          if (!live || hiddenRef.current) break
          notifyNeedsAttention(sessionTitleRef.current, {
            detail: question.prompt.slice(0, 80),
          })
          if (live && settleSoundRef.current) {
            playSettleSound('attention')
          }
          break
        }
        const respondedId = respondedInputId(event)
        if (respondedId !== null) {
          setPendingQuestion((prev) => (prev?.inputId === respondedId ? null : prev))
        }
      }
    }
  }, [])

  // The engine answers a declined command with `accepted: false` on a resolved
  // promise, not a rejection — so both have to be surfaced, or a rejected send
  // looks like a no-op. `onRejected` lets a caller put the user's text back.
  const dispatch = useCallback(
    (
      command: Record<string, unknown>,
      failureTitle: string,
      onRejected?: (reason: string, uncertain?: boolean) => void,
    ): Promise<boolean> => {
      const fail = (reason: string, uncertain = false): void => {
        onRejected?.(reason, uncertain)
        if (
          viewMountedRef.current &&
          !hiddenRef.current &&
          command.sessionId === sessionIdRef.current
        ) {
          toast({ title: failureTitle, description: reason, tone: 'danger', durationMs: 6000 })
        }
      }
      return rpc
        .invoke('command.dispatch', { command })
        .then((result) => {
          if (!result.accepted) {
            fail(result.reason ?? 'The command was rejected.')
            return false
          }
          return true
        })
        .catch((err: unknown) => {
          let uncertain = !remote
          if (remote) {
            try {
              uncertain = rpc.receipt() !== null
            } catch {
              uncertain = true
            }
          }
          fail(err instanceof Error ? err.message : String(err), uncertain)
          return false
        })
        .finally(() => setReceiptRevision((value) => value + 1))
    },
    [toast, rpc, remote],
  )

  const rememberUnsent = useCallback(
    (message: Omit<UnsentMessage, 'id'>) => {
      updateSessionDraftIntent(viewKey, (state) => ({
        ...state,
        recoveries: [
          ...state.recoveries,
          {
            ...message,
            id: crypto.randomUUID(),
            images: message.images ?? message.files.map(imageIntent),
            delivery: message.delivery ?? 'unsent',
          },
        ],
      }))
    },
    [viewKey],
  )

  const recoverMessage = useCallback(
    (message: ComposerRecovery, current: ComposerDraft, focus: boolean): boolean => {
      if (
        hostBlocked ||
        hiddenRef.current ||
        sessionIdRef.current !== sessionId ||
        readSessionDraftIntent(viewKey).pendingId
      )
        return false
      const state = readSessionDraftIntent(viewKey)
      const saved = state.recoveries.find((entry) => entry.id === message.id)
      if (!saved) return false
      const latest = {
        ...current,
        text: readSessionDraftText(viewKey),
        files: state.images.flatMap((image) => (image.file ? [image.file] : [])),
        images: state.images,
      }
      if (!focus && (latest.text.length > 0 || latest.images.length > 0)) return false
      const notes = readReviewDrafts(viewKey)
      const picks = browserPicksState(viewKey)
      const remaining = state.recoveries.filter((entry) => entry.id !== saved.id)
      if (
        latest.text.length > 0 ||
        latest.images.length > 0 ||
        notes.length > 0 ||
        picks.length > 0
      ) {
        remaining.push({
          ...latest,
          notes,
          picks,
          id: crypto.randomUUID(),
          autoRestore: false,
          delivery: state.delivery ?? 'saved',
          reattachRequired: state.reattachRequired,
        })
      }
      updateSessionDraftIntent(viewKey, (prev) => ({
        ...prev,
        images: saved.images,
        picks: saved.picks,
        recoveries: remaining,
        delivery: saved.delivery === 'uncertain' ? 'uncertain' : undefined,
        reattachRequired: saved.reattachRequired,
      }))
      writeReviewDrafts(viewKey, saved.notes)
      setComposerSeed((prev) => ({
        text: saved.text,
        files: saved.files,
        images: saved.images,
        sessionId: viewKey,
        nonce: (prev?.nonce ?? 0) + 1,
        replaceFiles: true,
        focus,
      }))
      return true
    },
    [sessionId, viewKey, hostBlocked],
  )

  const recoveries = useMemo(
    () => draftIntent.recoveries.filter((message) => message.id !== draftIntent.pendingId),
    [draftIntent.recoveries, draftIntent.pendingId],
  )

  const dispatchSend = useCallback(
    (
      text: string,
      attachments: AttachmentRef[],
      files: File[],
      fromComposer = true,
      images?: DraftImage[],
    ): boolean => {
      // Reserve synchronously: repeated Enter/clicks can precede React's render.
      if (
        hostBlocked ||
        hiddenRef.current ||
        sessionIdRef.current !== sessionId ||
        readSessionDraftIntent(viewKey).pendingId
      )
        return false
      // Snapshot context before asynchronous image preparation. New notes/picks
      // belong to the next draft, including when another session becomes active.
      const notes = fromComposer ? readReviewDrafts(viewKey) : []
      const picks = fromComposer ? browserPicksState(viewKey) : []
      const composerImages = images ?? files.map(imageIntent)
      const pickImages = picks.flatMap((pick) =>
        pick.imageIntent ? [pick.imageIntent] : pick.image ? [imageIntent(pick.image)] : [],
      )
      const allImages = [...pickImages, ...composerImages]
      if (allImages.some((image) => !image.file && !image.ref)) return false
      if (allImages.length + attachments.length > 4) {
        toast({
          title: 'Too many images',
          description: 'Attach at most four images, including selected page elements.',
          tone: 'danger',
        })
        return false
      }
      const state = readSessionDraftIntent(viewKey)
      if (fromComposer && state.reattachRequired) return false
      if (fromComposer && state.recoveries.length >= MAX_RECOVERIES) {
        toast({
          title: 'Saved messages are full',
          description: 'Restore or remove a saved message before sending another.',
          tone: 'danger',
        })
        return false
      }
      const receiptId = crypto.randomUUID()
      updateSessionDraftIntent(viewKey, (prev) => ({
        ...prev,
        pendingId: receiptId,
        recoveries: fromComposer
          ? [
              ...prev.recoveries,
              {
                id: receiptId,
                text,
                files,
                images: composerImages,
                notes,
                picks,
                delivery: 'preparing',
                autoRestore: false,
              },
            ]
          : prev.recoveries,
      }))
      if (fromComposer) takeBrowserPicks(viewKey)
      const elementBlock = promptForPicks(picks)
      const outgoing = [elementBlock, formatReviewDrafts(notes), text]
        .filter((part) => part.length > 0)
        .join('\n\n')
      if (notes.length > 0) writeReviewDrafts(viewKey, [])
      const restoreDraft = (_reason?: string, uncertain = false): void => {
        // Regenerate/retry already has its complete message in the transcript.
        // Recovery never merges a failed message into a newer draft.
        if (fromComposer)
          updateSessionDraftIntent(viewKey, (prev) => ({
            ...prev,
            recoveries: prev.recoveries.map((entry) =>
              entry.id === receiptId
                ? {
                    ...entry,
                    delivery: uncertain ? 'uncertain' : 'unsent',
                    autoRestore: !uncertain,
                  }
                : entry,
            ),
          }))
      }
      const prepared = (async (): Promise<DraftImage[]> => {
        // A durable ref can outlive bytes removed from disk. Verify restored refs
        // through the existing attachment reader before a prompt can use them.
        const checked = await Promise.all(
          allImages.map(async (image) => {
            if (!image.ref) return image
            const result = await rpc.invoke('attachments.read', { id: image.ref.id })
            return result.attachment ? image : { ...image, ref: undefined }
          }),
        )
        if (checked.some((image) => !image.file && !image.ref)) return checked
        const filesToStage = checked.flatMap((image) =>
          !image.ref && image.file ? [image.file] : [],
        )
        const refs = filesToStage.length ? await rpc.stageImages(filesToStage) : []
        if (refs.length !== filesToStage.length)
          throw new Error('Some images were not staged. Your message has been saved.')
        let index = 0
        return checked.map((image) => ({ ...image, ref: image.ref ?? refs[index++] }))
      })()
      void prepared
        .then(
          (staged) => {
            if (readSessionDraftIntent(viewKey).pendingId !== receiptId) return false
            const refs = [
              ...attachments,
              ...staged.flatMap((image) => (image.ref ? [image.ref] : [])),
            ]
            let pickIndex = 0
            const stagedPicks = picks.map((pick) =>
              pick.image || pick.imageIntent ? { ...pick, imageIntent: staged[pickIndex++] } : pick,
            )
            updateSessionDraftIntent(viewKey, (prev) => ({
              ...prev,
              recoveries: prev.recoveries.map((entry) =>
                entry.id === receiptId
                  ? {
                      ...entry,
                      images: staged.slice(pickImages.length),
                      picks: stagedPicks,
                      delivery: staged.some((image) => !image.ref) ? 'preparing' : 'pending',
                    }
                  : entry,
              ),
            }))
            if (staged.some((image) => !image.ref)) {
              restoreDraft()
              if (viewMountedRef.current && !hiddenRef.current)
                toast({
                  title: 'Images need reattachment',
                  description:
                    'Staged image bytes are unavailable. Restore the saved message and reattach its images.',
                  tone: 'danger',
                })
              return false
            }
            return dispatch(
              {
                type: running ? 'message.enqueue' : 'turn.start',
                sessionId,
                text: outgoing,
                attachments: refs,
              },
              running ? 'Couldn’t queue message' : 'Couldn’t send message',
              restoreDraft,
            ).then((accepted) => {
              if (accepted)
                updateSessionDraftIntent(viewKey, (prev) => ({
                  ...prev,
                  recoveries: prev.recoveries.filter((entry) => entry.id !== receiptId),
                }))
              if (
                accepted &&
                viewMountedRef.current &&
                !running &&
                sessionIdRef.current === sessionId
              )
                setTurnError(null)
              return accepted
            })
          },
          (err: unknown) => {
            restoreDraft(undefined, remote && rpc.receipt() !== null)
            if (
              viewMountedRef.current &&
              !hiddenRef.current &&
              sessionIdRef.current === sessionId
            ) {
              toast({
                title: 'Couldn’t attach images',
                description: err instanceof Error ? err.message : String(err),
                tone: 'danger',
                durationMs: 6000,
              })
            }
          },
        )
        .finally(() => {
          setReceiptRevision((value) => value + 1)
          updateSessionDraftIntent(viewKey, (prev) =>
            prev.pendingId === receiptId ? { ...prev, pendingId: undefined } : prev,
          )
        })
      return true
    },
    [sessionId, viewKey, hostBlocked, remote, rpc, running, dispatch, toast],
  )

  const handleSend = useCallback(
    (text: string, files: File[], images?: DraftImage[]) =>
      dispatchSend(text, [], files, true, images),
    [dispatchSend],
  )

  const handleTurnInView = useCallback(
    (turnId: string) => {
      turnsInView.add(turnId)
      if (historyReadySession === sessionId && settledTurnIdsRef.current.has(turnId))
        fetchTurnDiffRef.current(turnId)
    },
    [historyReadySession, sessionId, turnsInView],
  )

  const retryTurnDiff = useCallback((turnId: string) => {
    fetchedTurnIdsRef.current.delete(turnId)
    setTurnDiffs((prev) => {
      const next = { ...prev }
      delete next[turnId]
      return next
    })
    fetchTurnDiffRef.current(turnId)
  }, [])

  /** Restores the workspace to the checkpoint taken when the turn began. */
  const undoTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      try {
        const result = await rpc.invoke('command.dispatch', {
          command: { type: 'checkpoint.revert', sessionId, turnId },
        })
        if (!result.accepted) throw new Error(result.reason ?? 'The engine rejected the revert.')
        toast({
          title: 'Changes undone',
          description: 'Files are back to before that turn.',
          tone: 'success',
        })
        return true
      } catch (err) {
        toast({
          title: 'Couldn’t undo',
          description: err instanceof Error ? err.message : String(err),
          tone: 'danger',
          durationMs: 6000,
        })
        return false
      }
    },
    [sessionId, toast],
  )

  /** M21.1 review loop: a saved diff line note joins the next message. */
  const handleDiffComment = useCallback(
    (comment: { path: string; line: number | null; text: string }) => {
      appendReviewNote(viewKey, comment)
    },
    [sessionId],
  )

  const handleStop = useCallback(() => {
    void dispatch({ type: 'turn.interrupt', sessionId }, 'Couldn’t stop the turn')
  }, [sessionId, dispatch])

  // Queue management. Steering is best-effort by nature — the engine reports a
  // provider that cannot take a mid-turn message, and the message stays queued.
  const handleSteerQueued = useCallback(
    (message: QueuedMessageView) => {
      void dispatch(
        {
          type: 'message.steer',
          sessionId,
          text: message.text,
          attachments: message.attachments,
        },
        'Couldn’t steer message',
      )
    },
    [sessionId, dispatch],
  )

  const handleRemoveQueued = useCallback(
    (message: QueuedMessageView) => {
      void dispatch(
        {
          type: 'message.dequeue',
          sessionId,
          text: message.text,
          attachments: message.attachments,
        },
        'Couldn’t remove queued message',
      )
    },
    [sessionId, dispatch],
  )

  // Edit is a text-only draft. An imaged message has nowhere to carry its
  // attachments, so it stays queued instead of dropping them on the way back.
  const handleEditQueued = useCallback(
    (message: QueuedMessageView) => {
      if (message.attachments.length > 0) return
      if (readSessionDraftIntent(viewKey).recoveries.length >= MAX_RECOVERIES) return
      // The draft changes only after the engine accepts the dequeue. Applying
      // it first wipes an in-progress draft when the row was already sent.
      void dispatch(
        {
          type: 'message.dequeue',
          sessionId,
          text: message.text,
          attachments: message.attachments,
        },
        'Couldn’t edit queued message',
      ).then((accepted) => {
        if (!accepted) return
        rememberUnsent({ sessionId, text: message.text, files: [], notes: [], picks: [] })
      })
    },
    [sessionId, dispatch, rememberUnsent],
  )

  // M19.4 edit-and-resend: filling the composer (and focusing it) is all an
  // edit does; sending then starts a new turn through the normal send path.
  const handleEditMessage = useCallback(
    (text: string) => {
      setComposerSeed((prev) => ({ text, sessionId: viewKey, nonce: (prev?.nonce ?? 0) + 1 }))
    },
    [sessionId],
  )

  // Quote splices a blockquote at the caret and keeps whatever is already drafted.
  const handleQuoteAssistant = useCallback(
    (quote: string) => {
      setComposerSeed((prev) => ({
        text: quote,
        nonce: (prev?.nonce ?? 0) + 1,
        mode: 'insert',
        sessionId: viewKey,
      }))
    },
    [sessionId],
  )

  // M19.4 regenerate/retry: the prompt to re-run is the most recent user
  // message's text plus its staged image refs (null when the transcript has
  // no user message yet).
  const lastUser = useTranscriptSelector(store, lastUserOf)
  const lastUserMessage = useMemo((): { text: string; attachments: AttachmentRef[] } | null => {
    const m = lastUser
    // A turn another session or Ari itself started is not the user's to
    // resend: it would go back out as if they had typed it.
    if (m === null || (m.origin && m.origin.kind !== 'human')) return null
    const text = m.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    const attachments: AttachmentRef[] = m.parts
      .filter((part) => part.type === 'image')
      .map((part) => ({
        id: part.attachmentId,
        name: part.name,
        mimeType: part.mimeType,
        size: part.size,
      }))
    if (text.length === 0 && attachments.length === 0) return null
    return { text, attachments }
  }, [lastUser])

  // Both regenerate (assistant footer) and retry (error banner) resend the
  // last user prompt as a fresh turn via the normal send path; disabled while
  // a turn runs so it can never enqueue behind itself.
  const resendLastPrompt = useCallback(() => {
    if (running || lastUserMessage === null) return
    // No composer Files to restore: the resend does not come from the draft.
    dispatchSend(lastUserMessage.text, lastUserMessage.attachments, [], false)
  }, [running, lastUserMessage, dispatchSend])

  const respondApproval = useCallback(
    (approvalId: string, answer: ApprovalAnswer) => {
      void dispatch(
        { type: 'approval.respond', sessionId, approvalId, ...answer },
        'Could not send approval',
      )
    },
    [sessionId, dispatch],
  )

  const respondQuestion = useCallback(
    (value: string) => {
      if (pendingQuestion === null) return
      const current = pendingQuestion
      // Whether the turn was alive when the user answered: a turn that died
      // underneath the answer (e.g. Stop) owns no question anymore, so a
      // rejected dispatch must not resurrect its card.
      const turnAlive = running
      // Drop the overlay immediately so Submit cannot leave a locked card
      // sitting on screen while the engine journals the answer.
      setPendingQuestion(null)
      void dispatch(
        {
          type: 'input.respond',
          sessionId,
          inputId: current.inputId,
          value,
        },
        'Could not send answer',
      )
        .then((accepted) => {
          if (accepted) return
          if (turnAlive) setPendingQuestion(current)
          toast({
            title: 'Couldn’t send answer',
            description: turnAlive
              ? 'The agent is no longer waiting on this question.'
              : 'The turn ended before your answer was sent.',
            tone: 'danger',
            durationMs: 6000,
          })
        })
        .catch((err: unknown) => {
          if (turnAlive) setPendingQuestion(current)
          toast({
            title: 'Couldn’t send answer',
            description: err instanceof Error ? err.message : String(err),
            tone: 'danger',
            durationMs: 6000,
          })
        })
    },
    [sessionId, pendingQuestion, running, toast, dispatch],
  )

  /**
   * Skips the parked question: an empty value is the dismissal convention —
   * adapters answer `cancelled` so the agent proceeds with its best judgment
   * instead of parking on the question forever.
   */
  const cancelQuestion = useCallback(() => {
    respondQuestion('')
  }, [respondQuestion])

  const changeModel = useCallback(
    (next: { driverKind: DriverKind; modelId: string | null }) => {
      if (hostBlocked) return
      const switched = next.driverKind !== defaults.driverKind
      if (switched && providerLocked) return
      const switchProvider =
        switched && (remote || (providerSwitchable && hasProviderContext(providerContext)))
      const effort = switched && (remote || providerSwitchable) ? { effort: null } : {}
      const before = {
        driverKind: defaultsRef.current.driverKind,
        modelId: defaultsRef.current.modelId,
        effort: defaultsRef.current.effort,
      }
      const pick: Partial<typeof before> = { ...next, ...effort }
      const changedFields = (Object.keys(pick) as (keyof typeof before)[]).filter(
        (field) => pick[field] !== before[field],
      )
      const effortRevision = effortRevisionRef.current
      const picks = modelPicksRef.current
      if (picks.pending === 0)
        picks.confirmed = {
          driverKind: defaultsRef.current.driverKind,
          modelId: defaultsRef.current.modelId,
          effort: defaultsRef.current.effort,
        }
      const sequence = ++picks.sequence
      picks.pending++
      if (!switchProvider && !remote) {
        onDefaultsChange({ ...defaultsRef.current, ...next, ...effort })
      }
      void dispatch(
        switchProvider
          ? { type: 'session.provider.switch', sessionId, ...next, effort: null }
          : { type: 'session.update', sessionId, ...next, ...effort },
        'Couldn’t change model',
      ).then((accepted) => {
        if (modelPicksRef.current !== picks) return
        picks.pending--
        const current = defaultsRef.current
        if (remote) {
          if (accepted && sequence === picks.sequence && viewMountedRef.current) {
            onDefaultsChange({ ...current, ...next, ...effort })
            onPick?.({ ...next, ...effort })
          }
          return
        }
        const acceptedEffort =
          effortRevision === effortRevisionRef.current &&
          (current.effort === pick.effort || (switchProvider && current.effort === before.effort))
            ? effort
            : {}
        if (accepted) {
          picks.confirmed = { ...picks.confirmed, ...next, ...acceptedEffort }
          onPick?.({ ...next, ...acceptedEffort })
        }
        // An older rejection must not overwrite a more recent optimistic pick.
        if (sequence !== picks.sequence) return
        if (!accepted || switchProvider || remote) {
          const patch = Object.fromEntries(
            changedFields
              .filter(
                (field) =>
                  (field !== 'effort' || effortRevision === effortRevisionRef.current) &&
                  (current[field] === pick[field] ||
                    (switchProvider && current[field] === before[field])),
              )
              .map((field) => [field, accepted ? pick[field] : picks.confirmed[field]]),
          ) as Partial<typeof before>
          onDefaultsChange({ ...current, ...patch })
        }
      })
    },
    [
      sessionId,
      onDefaultsChange,
      onPick,
      defaults,
      providerSwitchable,
      providerContext,
      providerLocked,
      dispatch,
      hostBlocked,
      remote,
    ],
  )

  const changeEffort = useCallback(
    (effort: string | null) => {
      if (hostBlocked) return
      if (remote) {
        void dispatch(
          { type: 'session.update', sessionId, effort },
          'Could not change effort',
        ).then((accepted) => {
          if (!accepted || !viewMountedRef.current) return
          effortRevisionRef.current++
          modelPicksRef.current.confirmed.effort = effort
          onDefaultsChange({ ...defaultsRef.current, effort })
          onPick?.({ effort })
        })
        return
      }
      effortRevisionRef.current++
      modelPicksRef.current.confirmed.effort = effort
      onDefaultsChange({ ...defaults, effort })
      onPick?.({ effort })
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'session.update', sessionId, effort },
        })
        .catch(() => undefined)
    },
    [sessionId, onDefaultsChange, onPick, defaults, hostBlocked, remote, dispatch],
  )

  const changePermissionMode = useCallback(
    (permissionMode: PermissionMode) => {
      if (hostBlocked) return
      if (remote) {
        void dispatch(
          { type: 'session.update', sessionId, permissionMode },
          'Could not change permission mode',
        ).then((accepted) => {
          if (accepted && viewMountedRef.current)
            onDefaultsChange({ ...defaultsRef.current, permissionMode })
        })
        return
      }
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
    [sessionId, onDefaultsChange, defaults, hostBlocked, remote, dispatch],
  )

  const delegations = useMemo(
    // One shared empty list for the common case: the activity lookup is new on
    // every render, and a fresh array each time would re-derive the transcript.
    () =>
      tasks === null || spawns.length === 0
        ? NO_DELEGATIONS
        : delegatedChildren(spawns, tasks, activityOf),
    [spawns, tasks, activityOf],
  )

  // A parent that ended its turn to wait has no Stop of its own, yet its
  // children may run for a long time. The rail offers one for all of them.
  const delegatedWorkLive =
    delegations.some(
      (child) => !['idle', 'done', 'failed', 'stopped', 'removed'].includes(child.state),
    ) ||
    childSessions.some((child) => {
      const phase = activityOf?.(child.id)?.phase
      return phase === 'working' || phase === 'paused'
    })
  const stopChildren = useCallback(() => {
    if (stoppingChildren || hostBlocked) return
    setStoppingChildren(true)
    void (
      remote
        ? rpc.invoke('session.stopChildren', { sessionId })
        : rpc.invoke('orchestration.stop', {
            sessionId,
            tree: true,
            idempotencyKey: (stopChildrenKeyRef.current ??= `work_${crypto.randomUUID()}`),
          })
    )
      .then(() => {
        stopChildrenKeyRef.current = null
        refreshTasksRef.current()
      })
      .catch(() => toast({ tone: 'danger', title: 'Could not stop the child sessions' }))
      .finally(() => {
        setStoppingChildren(false)
        setReceiptRevision((value) => value + 1)
      })
  }, [sessionId, rpc, remote, toast, stoppingChildren, hostBlocked])

  useEffect(() => {
    if (childSessions.length > 0) refreshTasksRef.current()
  }, [childSessions.length])

  useEffect(
    () => rpc.subscribe('orchestration.changed', { sessionId }, () => refreshTasksRef.current()),
    [sessionId],
  )

  const turnResume = useTurnResume(sessionId, turnError, defaults.driverKind)

  // What the composer's ArrowUp recalls: prompts typed here, not messages
  // another session or Ari put into this conversation.
  const humanPrompts = useTranscriptSelector(store, humanPromptsOf, sameItems)
  const sentPrompts = useMemo(
    () =>
      humanPrompts.map((m) =>
        m.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n'),
      ),
    [humanPrompts],
  )
  const transcriptEmpty = useTranscriptSelector(store, isEmpty)

  const pendingPlan = useMemo(() => {
    if (pendingQuestion === null) return null
    const payload = parseQuestionPayload(pendingQuestion.prompt, pendingQuestion.choicesJson)
    return payload.kind === 'plan-approval' ? payload : null
  }, [pendingQuestion])

  /**
   * Docked UI that needs an answer before anything else. Feeds the composer's
   * resting state — the plate must never fold up under a question or an
   * approval card, which would hide the thing the user has to act on. A plan
   * approval is answered in the side panel, so it does not count here, and a
   * child-session rail is a peek strip that does not pin either.
   */
  const composerAttentionRequired =
    (pendingQuestion !== null && pendingPlan === null) || approvals.length > 0
  const centered =
    !loading &&
    historyFailureSession !== sessionId &&
    metadataFailureSession !== sessionId &&
    transcriptEmpty &&
    !running &&
    !composerAttentionRequired &&
    pendingPlan === null &&
    turnError === null

  const backgroundShown = backgroundSummary(background.tasks, background.reporting) !== null
  const queuedForComposer = useMemo(
    () =>
      queued.map((message) => ({
        ...message,
        ...(message.origin && message.origin.kind !== 'human'
          ? {
              senderLabel:
                message.origin.kind === 'session' || message.origin.kind === 'question'
                  ? (sessionTitle?.(message.origin.sessionId) ?? 'Agent message')
                  : message.origin.kind === 'completion'
                    ? 'Agent results'
                    : 'Scheduled message',
            }
          : {}),
      })),
    [queued, sessionTitle],
  )

  // The composer is built only when something it shows changes: a session
  // view re-render (telemetry, child snapshots) must not re-render the editor
  // and its chips, nor re-measure the dock's layout animation around it.
  const composer = useMemo(
    () => (
      <Composer
        centered={centered}
        onReady={
          !hidden && centered && metadataReadySession === sessionId ? onComposerReady : undefined
        }
        sessionId={viewKey}
        onSend={handleSend}
        sendPending={sendPending}
        recoveries={recoveries}
        onRecover={recoverMessage}
        onStop={handleStop}
        running={running}
        queued={queuedForComposer}
        onSteerQueued={handleSteerQueued}
        onRemoveQueued={handleRemoveQueued}
        onEditQueued={handleEditQueued}
        seed={composerSeed ?? undefined}
        suggestions={fileSuggestions.length > 0 ? fileSuggestions : undefined}
        attentionRequired={composerAttentionRequired}
        history={sentPrompts}
        above={
          // A plan approval is answered in the side panel, so it mounts no
          // QuestionPanel and must not raise the strip on its own — an
          // `above` of empty children still draws the border.
          composerAttentionRequired || childSessions.length > 0 || backgroundShown ? (
            <fieldset
              disabled={hostBlocked}
              className="min-w-0"
              title={
                hostBlocked
                  ? (actionReason('session.prompt') ?? 'This session is read-only.')
                  : undefined
              }
            >
              {/* The question rides in the same layer as the approvals: the
                  strip that peeks out from behind the composer. A plan approval
                  is not asked here — it has the side panel. */}
              {pendingQuestion !== null && pendingPlan === null ? (
                <>
                  <fieldset
                    disabled={actionReason('input.respond') !== null}
                    title={actionReason('input.respond') ?? undefined}
                    className="min-w-0"
                  >
                    <QuestionPanel
                      prompt={pendingQuestion.prompt}
                      choicesJson={pendingQuestion.choicesJson}
                      onRespond={respondQuestion}
                      onCancel={cancelQuestion}
                    />
                  </fieldset>
                  {approvals.length > 0 || childSessions.length > 0 ? (
                    <div className="border-t border-border" />
                  ) : null}
                </>
              ) : null}
              {approvals.length > 0 ? (
                <div className="max-h-40 space-y-px overflow-y-auto">
                  {approvals.map((a, i) => (
                    <fieldset
                      key={a.approvalId}
                      disabled={
                        actionReason('approval.respond') !== null ||
                        (remote && a.options.length === 0)
                      }
                      title={
                        actionReason('approval.respond') ??
                        (remote && a.options.length === 0
                          ? 'This host approval has no named options to answer.'
                          : undefined)
                      }
                      className="min-w-0"
                    >
                      <ApprovalCard
                        key={a.approvalId}
                        approvalId={a.approvalId}
                        toolName={a.toolName}
                        summaryJson={a.summaryJson}
                        options={a.options}
                        position={i + 1}
                        total={approvals.length}
                        onRespond={(answer) => respondApproval(a.approvalId, answer)}
                      />
                    </fieldset>
                  ))}
                </div>
              ) : null}
              {childSessions.length > 0 ? (
                <ChildSessionActivity
                  sessions={childSessions}
                  activityOf={activityOf}
                  onOpen={onOpenSession}
                  // While this session runs, its own Stop reaches the children.
                  onStopAll={!running && delegatedWorkLive ? stopChildren : undefined}
                  stopping={stoppingChildren}
                />
              ) : null}
              {backgroundShown ? (
                <>
                  {composerAttentionRequired || childSessions.length > 0 ? (
                    <div className="border-t border-border" />
                  ) : null}
                  <BackgroundWork
                    providerLabel={defaults.driverKind === 'claude' ? 'Claude' : undefined}
                    tasks={background.tasks}
                    reporting={background.reporting}
                    since={background.since}
                  />
                </>
              ) : null}
            </fieldset>
          ) : null
        }
        leading={
          <>
            <fieldset
              disabled={updateReason !== null}
              title={updateReason ?? undefined}
              className="contents"
            >
              <ModelSelector
                hostCatalog={remote ? hostCatalog : undefined}
                driverKind={defaults.driverKind}
                modelId={defaults.modelId}
                onChange={changeModel}
                lockedTo={providerLocked ? defaults.driverKind : null}
              />
              <EffortChip
                driverKind={defaults.driverKind}
                modelId={defaults.modelId}
                effort={defaults.effort}
                onChange={changeEffort}
                disabledReason={updateReason}
              />
              <PermissionModeChip
                driverKind={defaults.driverKind}
                mode={defaults.permissionMode}
                onChange={changePermissionMode}
                disabledReason={updateReason}
              />
            </fieldset>
            {managedWorkspace ? (
              <span
                className="max-w-40 truncate text-2xs text-fg-subtle"
                title={managedWorkspace.path}
              >
                Worktree · {managedWorkspace.branch}
              </span>
            ) : null}
          </>
        }
      />
    ),
    [
      centered,
      viewKey,
      remote,
      hostCatalog,
      hostBlocked,
      updateReason,
      sendReason,
      hidden,
      metadataReadySession,
      managedWorkspace,
      onComposerReady,
      sessionId,
      handleSend,
      sendPending,
      recoveries,
      recoverMessage,
      handleStop,
      running,
      queuedForComposer,
      handleSteerQueued,
      handleRemoveQueued,
      handleEditQueued,
      composerSeed,
      fileSuggestions,
      composerAttentionRequired,
      sentPrompts,
      childSessions,
      pendingQuestion,
      pendingPlan,
      respondQuestion,
      cancelQuestion,
      approvals,
      respondApproval,
      activityOf,
      onOpenSession,
      delegatedWorkLive,
      stopChildren,
      stoppingChildren,
      backgroundShown,
      background,
      defaults.driverKind,
      defaults.modelId,
      defaults.effort,
      defaults.permissionMode,
      changeModel,
      changeEffort,
      changePermissionMode,
      telemetry.turnCount,
      providerSwitchable,
      providerLocked,
    ],
  )
  const startFromStarter = useCallback(
    (text: string) => {
      setComposerSeed({ text, sessionId: viewKey, nonce: Date.now() })
    },
    [sessionId],
  )

  /** What this host does not offer here, as "Feature: reason" lines. */
  const unavailableHere = remote
    ? (
        [
          ['files.index', 'File suggestions'],
          ['message.dequeue', 'Queue editing'],
          ['message.steer', 'Steering'],
          ['session.stopChildren', 'Stopping child sessions'],
          ['approval.respond', 'Approvals'],
          ['input.respond', 'Answers'],
        ] as const
      ).flatMap(([operation, label]) => {
        const reason = rpc.capabilityReason(operation)
        return reason ? [`${label}: ${reason}`] : []
      })
    : []

  const view = (
    <div className="ari-session-workspace relative flex h-full min-h-0">
      <div
        ref={canvasRef}
        className="ari-session-canvas relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col"
      >
        {/* The scene belongs to the empty stage: it is mounted only while it
            shows, so a conversation never paints or holds the art. It comes
            first and unraised, so everything after it draws on top. */}
        {centered ? (
          <DitherScene kind={helm ? 'aria' : 'session'} className="ari-session-scene" />
        ) : null}
        {helm && !centered ? <AriaHeader status={ariaStatus} /> : null}
        <ParentSessionLink parentSession={parentSession} onOpenSession={onOpenSession} />
        {/* A remote session that cannot act says why on one row in the
            conversation column, with the one action that can fix it. */}
        {remote && (rpc.readOnly || receiptPending) ? (
          <div
            role="status"
            className="ari-chat-column mt-3 flex items-center gap-3 rounded-xl border border-border bg-surface-1 px-3.5 py-2.5"
          >
            <span aria-hidden className="ari-status" data-status="attention" />
            <span className="min-w-0 flex-1 text-[13px] text-fg">
              {receiptPending
                ? (receiptError ??
                  'Submission outcome is unknown. Check its original receipt before sending again.')
                : (rpc.capabilityReason('events.desktop.subscribe') ??
                  'Cached session. Reconnect to continue.')}
            </span>
            <button
              type="button"
              className={outlineButton}
              onClick={() => {
                void (receiptPending ? rpc.checkReceipt() : rpc.reconnect())
                  .then(() => {
                    setReceiptRevision((value) => value + 1)
                    retryHistoryRef.current()
                    retryMetadataRef.current()
                  })
                  .catch((error: unknown) =>
                    toast({
                      title: 'Could not confirm host state',
                      description: error instanceof Error ? error.message : String(error),
                      tone: 'danger',
                    }),
                  )
              }}
            >
              {receiptPending ? 'Check status' : 'Reconnect'}
            </button>
          </div>
        ) : null}
        {remote && !hostBlocked && sendReason ? (
          <p role="status" className="ari-chat-column mt-2 text-[13px] text-fg-subtle">
            {sendReason}
          </p>
        ) : null}
        {remote && unavailableHere.length > 0 ? (
          <p className="ari-chat-column mt-1 text-xs text-fg-subtle">{unavailableHere.join(' ')}</p>
        ) : null}
        {startedByAria ? (
          <button type="button" onClick={onOpenAria} className={paneOriginLink}>
            <span aria-hidden="true" className="flex shrink-0">
              <AriaMark size={14} />
            </span>
            Started by Aria
          </button>
        ) : null}
        <div className={`min-h-0 flex-1 ${centered ? 'invisible' : ''}`} inert={centered}>
          <StoreTranscript
            sessionId={sessionId}
            store={store}
            loading={loading || (historyFailureSession === sessionId && transcriptEmpty)}
            turnDiffs={turnDiffs}
            onEditUserMessage={handleEditMessage}
            onQuoteAssistant={handleQuoteAssistant}
            onRegenerate={lastUserMessage !== null ? resendLastPrompt : undefined}
            regenerateDisabled={running || sendPending}
            running={running}
            chatStyle={engineSettings?.appearance.chatStyle ?? 'conversation'}
            header={<PlanPanel sessionId={sessionId} refreshNonce={planNonce} />}
            onDiffComment={handleDiffComment}
            onRetryTurnDiff={retryTurnDiff}
            onUndoTurn={remote ? undefined : undoTurn}
            working={running ? <WorkingGlyph startedAt={telemetry.startedAt} /> : null}
            delegations={delegations}
            providerSwitches={providerSwitches}
            modelLabel={modelLabel}
            sessionTitle={sessionTitle}
            onOpenSession={onOpenSession}
            onTurnInView={handleTurnInView}
            hidden={hidden}
          />
        </div>
        {historyFailureSession === sessionId ? (
          <div role="status" className={NOTICE_ROW}>
            <span aria-hidden="true" className="ari-status" data-status="error" />
            <span className="min-w-0 flex-1 text-fg">
              History is incomplete. Some saved messages could not be loaded.
            </span>
            <button
              type="button"
              disabled={historyRetrying}
              onClick={() => retryHistoryRef.current()}
              className={cx(outlineButton, 'shrink-0')}
            >
              {historyRetrying ? 'Retrying history…' : 'Retry history'}
            </button>
          </div>
        ) : null}
        {metadataFailureSession === sessionId ? (
          <div role="status" className={NOTICE_ROW}>
            <span aria-hidden="true" className="ari-status" data-status="error" />
            <span className="min-w-0 flex-1 text-fg">Session details could not be loaded.</span>
            <button
              type="button"
              disabled={metadataRetrying}
              onClick={() => retryMetadataRef.current()}
              className={cx(outlineButton, 'shrink-0')}
            >
              {metadataRetrying ? 'Retrying session details…' : 'Retry session details'}
            </button>
          </div>
        ) : null}
        {turnError ? (
          <TurnErrorBanner
            message={turnError}
            canRetry={lastUserMessage !== null}
            retryDisabled={running || sendPending}
            onRetry={resendLastPrompt}
            onDismiss={() => {
              dismissedErrorTurnIdRef.current = errorTurnIdRef.current
              setTurnError(null)
            }}
            resume={turnResume}
          />
        ) : null}
        <ElementChips picks={elementPicks} sessionId={viewKey} />
        {reviewNotes.length > 0 ? (
          <div
            className="ari-chat-column mb-2 flex shrink-0 flex-wrap items-center gap-1.5 px-3"
            aria-label="Review notes attached to next message"
          >
            <span className="text-[12.5px] text-fg-subtle">
              {reviewNotes.length} note{reviewNotes.length > 1 ? 's' : ''} with your next message:
            </span>
            {reviewNotes.map((note) => (
              <span
                key={note.id}
                className={cx(chip, 'max-w-64 pe-1')}
                title={note.context ?? note.text}
              >
                <span className="min-w-0 truncate">{reviewDraftChipLabel(note)}</span>
                <button
                  type="button"
                  aria-label={`Remove note ${note.text}`}
                  onClick={() =>
                    writeReviewDrafts(
                      sessionId,
                      reviewNotes.filter((item) => item.id !== note.id),
                    )
                  }
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-fg/9 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <ComposerDock
          centered={centered}
          canvasRef={canvasRef}
          reducedMotion={engineSettings?.appearance.reducedMotion ?? false}
          onStart={startFromStarter}
          aria={helm}
          ariaState={ariaStatus?.state}
        >
          {composer}
        </ComposerDock>
        {/* The last thing in the column: a quiet line under the composer, on
            the composer's own measure. */}
        <SessionStatusCapsule
          turnCount={telemetry.turnCount}
          lastDurationMs={telemetry.lastDurationMs}
          inputTokens={telemetry.inputTokens}
          cachedInputTokens={telemetry.cachedInputTokens}
          outputTokens={telemetry.outputTokens}
          context={telemetry.context}
          contextWindow={contextWindow}
          hidden={centered}
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
  // Hidden views keep their DOM and state; React defers their renders and
  // pauses the effects inside, so a background stream costs no layout.
  return <Activity mode={hidden ? 'hidden' : 'visible'}>{view}</Activity>
}

/**
 * Aria's header inside her stage: her mark, her name in pixel type, and one
 * sentence about the sessions she started, with what needs the user in the
 * accent. Without a status it is her name alone.
 */
function AriaHeader({ status }: { status?: ReturnType<typeof ariaActivity> }) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
      {/* Her name is right beside it, so the mark itself stays unannounced. */}
      <span aria-hidden="true" className="flex shrink-0">
        <AriaMark size={22} state={status?.state} />
      </span>
      <h2 className="ari-pixel shrink-0 text-[19px] leading-none text-fg">Aria</h2>
      {status ? (
        <p className="min-w-0 truncate text-sm text-fg-muted">
          {status.working === 0 && status.attention === 0 ? (
            'Nothing running.'
          ) : (
            <>
              {status.working > 0
                ? `${status.working} session${status.working === 1 ? '' : 's'} working`
                : null}
              {status.working > 0 && status.attention > 0 ? ', ' : null}
              {status.attention > 0 ? (
                <span className="text-accent">
                  {status.attention} need{status.attention === 1 ? 's' : ''} you
                </span>
              ) : null}
              .
            </>
          )}
        </p>
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

interface CatalogModelEfforts {
  id: string
  aliases?: string[]
  efforts?: EffortOption[]
  effortsSource?: 'agent' | 'fallback'
}

/**
 * Thought/reasoning chip backed by the harness's own ACP selector
 * (`thought_level`, `effort`, `reasoning_effort`, or a thinking-shaped mode
 * list). Hidden when the agent advertises nothing — we never invent
 * low/medium/high.
 *
 * Effort can be per-model (OpenCode only advertises it for
 * reasoning-capable models), so with a model selected the chip re-queries
 * that model's own levels and prefers them over the default-model catalog.
 */
export function EffortChip({
  driverKind,
  modelId,
  effort,
  onChange,
  disabledReason = null,
}: {
  driverKind: DriverKind
  modelId?: string | null
  effort: string | null
  onChange: (effort: string | null) => void
  disabledReason?: string | null
}) {
  const rpc = useSessionClient()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [options, setOptions] = useState<EffortOption[]>([])
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    // A model-specific probe is the authority on this model's vocabulary, so
    // `loaded` is withheld until it settles. Releasing it on the generic
    // catalog alone lets the reset effect below clear a saved effort that only
    // the model's own list advertises — the very case this control exists for.
    // Reset on every generation: leaving `loaded` true across a model switch
    // lets the catalog's first paint clear a saved effort the new model still
    // advertises.
    setLoaded(false)
    const probesModel = modelId !== undefined && modelId !== null && modelId.length > 0
    let agentEfforts = false
    let provisional = false
    const apply = (
      rows: { kind: string; models?: CatalogModelEfforts[]; efforts?: EffortOption[] }[],
    ): void => {
      if (cancelled) return
      const row = rows.find((r) => r.kind === driverKind)
      const model = probesModel
        ? row?.models?.find(
            (entry) => entry.id === modelId || entry.aliases?.includes(modelId ?? ''),
          )
        : undefined
      const modelEfforts = model?.efforts ?? []
      agentEfforts = modelEfforts.length > 0 && model?.effortsSource === 'agent'
      // The kind-level list was read against another model; only the agent's
      // answer for this one may judge a saved level.
      provisional = probesModel && !agentEfforts
      setOptions(modelEfforts.length > 0 ? modelEfforts : (row?.efforts ?? []))
      if (!probesModel || agentEfforts) setLoaded(true)
    }
    const load = (): void => {
      setLoaded(false)
      agentEfforts = false
      provisional = false
      const base = rpc
        .invoke('providers.models')
        .then(apply)
        .catch(() => {
          if (!cancelled) {
            setOptions([])
            if (!probesModel) setLoaded(true)
          }
        })
      // A selected model may advertise thought levels the default-model
      // catalog probe never saw; a non-empty answer wins, an empty one
      // keeps whatever the catalog reported.
      if (probesModel) {
        void base.finally(() => {
          if (cancelled || agentEfforts) return
          void rpc
            .invoke('providers.efforts', { kind: driverKind, modelId })
            .then((result) => {
              if (cancelled) return
              if (result.efforts.length > 0) {
                setOptions(result.efforts)
                setLoaded(true)
              }
            })
            .catch(() => undefined)
            .finally(() => {
              if (!cancelled && !provisional) setLoaded(true)
            })
        })
      }
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
  }, [driverKind, modelId, rpc, rpc.availability])

  useEffect(() => {
    // No list is not a verdict: an agent that has not answered yet (or a
    // probe that failed) would otherwise wipe the level the user saved.
    if (rpc.scope.kind === 'remote' || !loaded || effort === null || options.length === 0) return
    if (!options.some((o) => o.id === effort)) onChange(null)
  }, [loaded, options, effort, onChange])

  if (options.length === 0)
    return rpc.scope.kind === 'remote' ? (
      <button
        type="button"
        disabled
        title={disabledReason ?? 'The host has not reported effort choices.'}
        className={PICKER}
      >
        {effort === null ? 'Host default' : sentenceCase(effort)}
      </button>
    ) : null

  const selectedId =
    (effort !== null && options.some((o) => o.id === effort) ? effort : null) ??
    options.find((o) => o.current)?.id ??
    options[0]?.id
  const unknownEffort =
    rpc.scope.kind === 'remote' &&
    effort !== null &&
    !options.some((option) => option.id === effort)
  const current = options.find((o) => o.id === selectedId) ?? options[0]
  if (current === undefined) return null
  const levels = effortLevels(options)

  return (
    <div ref={setAnchor} className="relative">
      <button
        type="button"
        disabled={disabledReason !== null || unknownEffort}
        onClick={() => setOpen((o) => !o)}
        title={
          disabledReason ??
          (unknownEffort
            ? 'The host has not confirmed this saved effort.'
            : (current.description ?? `Effort: ${sentenceCase(current.label)}`))
        }
        aria-label={`Effort: ${unknownEffort ? effort : sentenceCase(current.label)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={PICKER}
      >
        <span>{unknownEffort ? effort : sentenceCase(current.label)}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className={`-ms-0.5 shrink-0 text-fg-subtle transition-transform duration-[var(--ari-dur-fast)] ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor}>
        <Popover.Content
          side="top"
          align="start"
          role="listbox"
          aria-label="Effort"
          className="w-44 overflow-hidden"
        >
          {options.map((option, index) => (
            <PickerOption
              key={option.id}
              label={sentenceCase(option.label)}
              // One line per level; the description is a hover away.
              title={option.description}
              mark={<EffortGlyph {...(levels[index] ?? { filled: 1, bars: 2 })} />}
              selected={option.id === selectedId}
              onSelect={() => {
                onChange(option.id)
                setOpen(false)
              }}
            />
          ))}
        </Popover.Content>
      </Popover>
    </div>
  )
}

const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask', hint: 'Confirm every edit and command' },
  { value: 'allow-edits', label: 'Edits', hint: 'Auto-approve edits; ask before commands' },
  { value: 'full', label: 'Full auto', hint: 'Approve everything automatically' },
]

const DEFAULT_MODE = PERMISSION_MODES[0] as (typeof PERMISSION_MODES)[number]

/** A permission mode the harness advertised over ACP, mapped to Ari's enum. */
interface DiscoveredModeOption {
  id: string
  label: string
  description?: string
  ariMode: PermissionMode
  current?: boolean
}

/** One picker row: an Ari mode, labeled by the harness's native mode when known. */
interface ModeEntry {
  value: PermissionMode
  label: string
  hint: string
  /** Advertised mode id this row represents; absent for Ari's own vocabulary. */
  nativeId?: string
  /** True when the harness reported this native mode as its current one. */
  nativeCurrent?: boolean
}

/**
 * Picker rows for the session's mode: per Ari mode, the harness's own modes
 * (codex `yolo`, claude `bypassPermissions`) when the probe classified any,
 * otherwise Ari's generic label. Native ids are display-only — the choice
 * still stores the Ari mode, which the driver maps back onto the agent's
 * vocabulary at turn start.
 */
function modeEntries(discovered: DiscoveredModeOption[]): ModeEntry[] {
  const entries: ModeEntry[] = []
  for (const fallback of PERMISSION_MODES) {
    const native = discovered.filter((o) => o.ariMode === fallback.value)
    if (native.length === 0) {
      entries.push(fallback)
      continue
    }
    for (const option of native) {
      entries.push({
        value: fallback.value,
        label: sentenceCase(option.label),
        hint: option.description ?? fallback.hint,
        nativeId: option.id,
        nativeCurrent: option.current === true,
      })
    }
  }
  return entries
}

/** Permission-mode chip in the composer foot. */
export function PermissionModeChip({
  driverKind,
  mode,
  onChange,
  disabledReason = null,
}: {
  driverKind: DriverKind
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabledReason?: string | null
}) {
  const rpc = useSessionClient()
  const [open, setOpen] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredModeOption[]>([])
  const menuRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const apply = (rows: { kind: string; modes?: DiscoveredModeOption[] }[]): void => {
      if (cancelled) return
      setDiscovered(rows.find((r) => r.kind === driverKind)?.modes ?? [])
    }
    const load = (): void => {
      void rpc
        .invoke('providers.models')
        .then(apply)
        .catch(() => {
          if (!cancelled) setDiscovered([])
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
  }, [driverKind, rpc, rpc.availability])

  const entries =
    rpc.scope.kind === 'remote'
      ? modeEntries(discovered).filter((entry) =>
          discovered.some((option) => option.ariMode === entry.value),
        )
      : modeEntries(discovered)
  const reason =
    disabledReason ??
    (rpc.scope.kind === 'remote' && discovered.length === 0
      ? 'The host has not reported permission choices.'
      : null)
  const current =
    entries.find((e) => e.value === mode && e.nativeCurrent === true) ??
    entries.find((e) => e.value === mode) ??
    PERMISSION_MODES.find((entry) => entry.value === mode) ??
    DEFAULT_MODE

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
    <div ref={setAnchor} className="relative">
      <button
        type="button"
        disabled={reason !== null}
        onClick={() => setOpen((o) => !o)}
        title={reason ?? `Permission mode: ${current.hint}`}
        aria-label={`Permission mode: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={PICKER}
      >
        <span>{current.label}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className={`-ms-0.5 shrink-0 text-fg-subtle transition-transform duration-[var(--ari-dur-fast)] ease-[var(--ari-ease-out-expo)] motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor}>
        <Popover.Content side="top" align="start" className="w-72 overflow-hidden">
          <div ref={menuRef} role="listbox" aria-label="Permission mode" onKeyDown={onMenuKeyDown}>
            {entries.map((m) => (
              <PickerOption
                key={m.nativeId ?? m.value}
                label={m.label}
                hint={m.hint}
                mark={<ModeMark mode={m.value} />}
                selected={m === current}
                onSelect={() => {
                  onChange(m.value)
                  setOpen(false)
                }}
              />
            ))}
          </div>
        </Popover.Content>
      </Popover>
    </div>
  )
}

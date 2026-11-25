import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'
import type { ChildTask } from '@ari/contracts/agent-control'
import type { ApprovalOption, PermissionMode } from '@ari/contracts/common'
import type { RemoteApproval, RemoteInput, RemoteSessionSummary } from '@ari/contracts/remote'
import type { Session, SessionStatus } from '@ari/contracts/session'

/**
 * A session as the phone holds it: the newest page of its transcript, folded
 * forward from live journal events between reads.
 *
 * Before this, every streamed frame made the phone download the whole
 * transcript again, so a long session over a relayed tailnet path spent most
 * of its time re-reading what it already had. Events are now applied here as
 * the desktop's projection applies them; a read is only needed for what the
 * phone cannot fold itself (delegated tasks, a gap in the stream) and as a
 * periodic reconcile.
 */
export interface Transcript {
  session: Session
  summary: RemoteSessionSummary
  /** Highest journal sequence folded into this state. */
  seq: number
  messages: Message[]
  pendingApprovals: RemoteApproval[]
  pendingInputs: RemoteInput[]
  tasks: ChildTask[]
  parent: { id: string; title: string } | null
  /** Messages older than the first one held; 0 when the transcript is complete. */
  earlier: number
}

/** What `session.get` answers with. `earlier` is absent from desktops that do not page. */
export interface TranscriptSnapshot {
  session: Session
  summary: RemoteSessionSummary
  seq: number
  messages: Message[]
  pendingApprovals: RemoteApproval[]
  pendingInputs: RemoteInput[]
  tasks?: ChildTask[]
  parent?: { id: string; title: string } | null
  earlier?: number
}

/** One journal event as the event stream carries it. */
export interface StreamedEvent {
  seq: number
  event: unknown
}

/**
 * What the caller should do after folding: nothing, re-read soon (something
 * changed that only the desktop can describe, such as delegated tasks), or
 * re-read now (the stream skipped ahead, so the state may be wrong).
 */
export type Reconcile = 'none' | 'soon' | 'now'

const RECONCILE_RANK: Record<Reconcile, number> = { none: 0, soon: 1, now: 2 }
function stronger(a: Reconcile, b: Reconcile): Reconcile {
  return RECONCILE_RANK[a] >= RECONCILE_RANK[b] ? a : b
}

/** Events whose effect on the screen only a fresh read can show. */
const READ_AFTER = new Set([
  'child.session.spawned',
  'child.session.settled',
  'child.session.integrated',
  'child.session.stopped',
  'child.session.destroyed',
  'child.session.acknowledged',
  'background.task.updated',
  'message.enqueued',
  'message.dequeued',
  'session.provider.switched',
  'session.created',
  'turn.settled',
])

/** Builds the state from a read, keeping older pages and unchanged message objects. */
export function fromSnapshot(
  snapshot: TranscriptSnapshot,
  previous: Transcript | null,
  /** Events already folded that may be newer than the read; re-applied on top. */
  recent: readonly StreamedEvent[] = [],
): Transcript {
  let messages = snapshot.messages
  let earlier = snapshot.earlier ?? 0
  if (previous !== null && snapshot.earlier !== undefined && snapshot.messages.length > 0) {
    // A page the user scrolled back to stays loaded across reconciles, as
    // long as the new page still joins onto it.
    const first = snapshot.messages[0]!.id
    const join = previous.messages.findIndex((message) => message.id === first)
    if (join > 0) {
      messages = [...previous.messages.slice(0, join), ...snapshot.messages]
      earlier = previous.earlier
    }
  }
  // Unchanged messages keep their identity, so the list re-renders only what changed.
  if (previous !== null) {
    const held = new Map(previous.messages.map((message) => [message.id, message]))
    messages = messages.map((message) => {
      const old = held.get(message.id)
      return old !== undefined && sameMessage(old, message) ? old : message
    })
  }
  const base: Transcript = {
    session: snapshot.session,
    summary: snapshot.summary,
    seq: snapshot.seq,
    messages,
    pendingApprovals: snapshot.pendingApprovals,
    pendingInputs: snapshot.pendingInputs,
    tasks: snapshot.tasks ?? previous?.tasks ?? [],
    parent: snapshot.parent ?? null,
    earlier,
  }
  const newer = recent.filter((entry) => entry.seq > snapshot.seq)
  return newer.length === 0 ? base : applyEvents(base, newer).transcript
}

/** Adds an older page in front of what is held. */
export function prependPage(
  transcript: Transcript,
  page: { messages: Message[]; earlier?: number },
): Transcript {
  const held = new Set(transcript.messages.map((message) => message.id))
  const older = page.messages.filter((message) => !held.has(message.id))
  return {
    ...transcript,
    messages: [...older, ...transcript.messages],
    earlier: page.earlier ?? 0,
  }
}

/** Folds streamed journal events, in order, and says whether a read must follow. */
export function applyEvents(
  transcript: Transcript,
  events: readonly StreamedEvent[],
): { transcript: Transcript; reconcile: Reconcile } {
  let next = transcript
  let reconcile: Reconcile = 'none'
  for (const { seq, event } of events) {
    if (seq <= next.seq) continue
    // The stream resumes from the last sequence held; anything else is a gap.
    if (seq !== next.seq + 1) reconcile = 'now'
    const folded = applyOne(next, event)
    next = { ...folded.transcript, seq }
    reconcile = stronger(reconcile, folded.reconcile)
  }
  return { transcript: next, reconcile }
}

interface Fold {
  transcript: Transcript
  reconcile: Reconcile
}

function applyOne(state: Transcript, raw: unknown): Fold {
  if (typeof raw !== 'object' || raw === null || !('type' in raw))
    return { transcript: state, reconcile: 'now' }
  const event = raw as { type: string; at?: number } & Record<string, unknown>
  const reconcile: Reconcile = READ_AFTER.has(event.type) ? 'soon' : 'none'
  switch (event.type) {
    case 'user.message.added': {
      const message = event['message'] as Message
      if (state.messages.some((entry) => entry.id === message.id))
        return { transcript: state, reconcile }
      return { transcript: { ...state, messages: [...state.messages, message] }, reconcile }
    }
    case 'assistant.parts.appended': {
      // A replayed range rewrites earlier prose; only a read can show the result.
      if (event['replayFromSeq'] !== undefined) return { transcript: state, reconcile: 'now' }
      const messageId = String(event['messageId'])
      const parts = event['parts'] as MessagePart[]
      const index = state.messages.findIndex((entry) => entry.id === messageId)
      const messages = [...state.messages]
      if (index < 0) {
        const created: MessagePart[] = []
        pushMessageParts(created, parts)
        messages.push({
          id: messageId,
          sessionId: state.session.id,
          turnId: null,
          role: 'assistant',
          parts: created,
          createdAt: typeof event.at === 'number' ? event.at : Date.now(),
        })
      } else {
        const message = messages[index]!
        const merged = [...message.parts]
        pushMessageParts(merged, parts)
        messages[index] = { ...message, parts: merged }
      }
      return { transcript: { ...state, messages }, reconcile }
    }
    case 'session.status.changed': {
      const status = event['to'] as SessionStatus
      const { live: _live, ...summary } = state.summary
      return {
        transcript: {
          ...state,
          session: { ...state.session, status },
          // A status the phone just watched change is live by definition.
          summary:
            status === 'running' ? { ...summary, status, live: true } : { ...summary, status },
        },
        reconcile,
      }
    }
    case 'turn.settled':
      // The projection ends a turn's prompts with it; delegated approvals that
      // outlive it come back with the read this asks for.
      return {
        transcript: { ...state, pendingApprovals: [], pendingInputs: [] },
        reconcile,
      }
    case 'approval.requested': {
      const approval: RemoteApproval = {
        approvalId: String(event['approvalId']),
        toolName: String(event['toolName']),
        summaryJson: String(event['summaryJson']),
        options: (event['options'] as ApprovalOption[] | undefined) ?? [],
      }
      return {
        transcript: {
          ...state,
          pendingApprovals: [
            ...state.pendingApprovals.filter((entry) => entry.approvalId !== approval.approvalId),
            approval,
          ],
        },
        // Older journals carry no options; the desktop's read supplies them.
        reconcile: approval.options.length === 0 ? 'now' : reconcile,
      }
    }
    case 'approval.responded':
      return {
        transcript: {
          ...state,
          pendingApprovals: state.pendingApprovals.filter(
            (entry) => entry.approvalId !== event['approvalId'],
          ),
        },
        reconcile,
      }
    case 'input.requested': {
      const input: RemoteInput = {
        inputId: String(event['inputId']),
        prompt: String(event['prompt']),
        choicesJson: (event['choicesJson'] as string | null | undefined) ?? null,
      }
      return {
        transcript: {
          ...state,
          pendingInputs: [
            ...state.pendingInputs.filter((entry) => entry.inputId !== input.inputId),
            input,
          ],
        },
        reconcile,
      }
    }
    case 'input.responded':
      return {
        transcript: {
          ...state,
          pendingInputs: state.pendingInputs.filter((entry) => entry.inputId !== event['inputId']),
        },
        reconcile,
      }
    case 'session.updated': {
      const changes: Partial<Session> = {}
      if (typeof event['title'] === 'string') changes.title = event['title']
      if (event['modelId'] !== undefined) changes.modelId = event['modelId'] as string | null
      if (event['effort'] !== undefined) changes.effort = event['effort'] as string | null
      if (typeof event['permissionMode'] === 'string')
        changes.permissionMode = event['permissionMode'] as PermissionMode
      if (typeof event['driverKind'] === 'string')
        changes.driverKind = event['driverKind'] as Session['driverKind']
      if (typeof event['archived'] === 'boolean') changes.archived = event['archived']
      if (typeof event['pinned'] === 'boolean') changes.pinned = event['pinned']
      return {
        transcript: {
          ...state,
          session: { ...state.session, ...changes },
          summary: { ...state.summary, ...changes },
        },
        reconcile,
      }
    }
    default:
      return { transcript: state, reconcile }
  }
}

function sameMessage(a: Message, b: Message): boolean {
  return a.parts.length === b.parts.length && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether the conversation already shows what an optimistic bubble stands
 * for: a user message with the same words that arrived after it was sent.
 */
export function delivered(messages: readonly Message[], text: string, afterIndex: number): boolean {
  const wanted = text.trim()
  for (let index = messages.length - 1; index >= Math.max(0, afterIndex); index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const words = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim()
    if (words === wanted) return true
  }
  return false
}

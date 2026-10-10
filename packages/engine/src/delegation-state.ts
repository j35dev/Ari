import type { ChildWorkState } from '@ari/contracts/agent-control'
import type { SessionReadModel } from './projection'

export interface PendingCompletion {
  childSessionId: string
  turnId: string
  stopReason: 'completed' | 'interrupted' | 'error'
  settledAt: number
}

/** Child turn outcomes this session has neither read nor been told about, oldest first. */
export function pendingCompletions(parent: SessionReadModel): PendingCompletion[] {
  const pending: PendingCompletion[] = []
  for (const [childSessionId, completion] of Object.entries(parent.childCompletions ?? {})) {
    if (completion.acknowledged || completion.stopReason === undefined) continue
    pending.push({
      childSessionId,
      turnId: completion.turnId,
      stopReason: completion.stopReason,
      settledAt: completion.settledAt ?? 0,
    })
  }
  return pending.sort((a, b) => a.settledAt - b.settledAt)
}

/**
 * Classifies a child from its journal alone. `liveDescendants` counts sessions
 * below it that are still mid-turn.
 */
export function childWorkState(model: SessionReadModel, liveDescendants = 0): ChildWorkState {
  if (model.activeTurnId !== null) {
    return model.pendingApprovals.length > 0 || model.pendingInputs.length > 0
      ? 'blocked_on_user'
      : 'working'
  }
  if (model.lastTurn === undefined) return 'not_started'
  // A queue behind a clean settle is about to run; behind a stop it is held.
  if (model.queuedMessages.length > 0 && model.lastTurn.stopReason === 'completed') return 'working'
  // A result of its own children that it has yet to be woken with is still
  // work in progress; one it was stopped out of hearing is not.
  const owed = pendingCompletions(model).some((entry) => entry.stopReason !== 'interrupted')
  if (liveDescendants > 0 || owed) return 'waiting_for_children'
  return 'result_available'
}

export interface TurnReport {
  text: string
  truncated: boolean
}

/**
 * The report a turn ended on: the text after its last tool activity, not the
 * narration streamed before it. Streamed deltas are separate parts and are
 * rejoined without separators. Falls back to the last non-empty text run when
 * a turn ends on a tool call.
 */
export function finalAssistantText(
  model: SessionReadModel,
  turnId: string | null | undefined,
  maxChars = 8000,
): TurnReport {
  const message = [...model.messages]
    .reverse()
    .find((entry) => entry.role === 'assistant' && (!turnId || entry.turnId === turnId))
  if (!message) return { text: '', truncated: false }
  let run = ''
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (!part || part.type === 'thinking') continue
    if (part.type === 'text') {
      run = part.text + run
      continue
    }
    if (run.trim().length > 0) break
    run = ''
  }
  const text = run.trim()
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false }
}

export interface CompletionReport {
  sessionId: string
  title: string
  stopReason: 'completed' | 'interrupted' | 'error'
  errorMessage: string | null
  report: TurnReport
}

const OUTCOME = {
  completed: 'finished its turn',
  interrupted: 'was stopped before finishing',
  error: 'failed',
} as const

/**
 * The message a parent is woken with. It carries the reports themselves so
 * the common case needs no follow-up read, and says what is still running so
 * the parent ends its turn again instead of polling.
 */
export function completionNotice(
  reports: readonly CompletionReport[],
  stillWorking: readonly { sessionId: string; title: string }[],
): string {
  const sections = reports.map((entry) => {
    const head = `Child session "${entry.title}" (${entry.sessionId}) ${OUTCOME[entry.stopReason]}.`
    const error =
      entry.stopReason === 'error' && entry.errorMessage ? `\nError: ${entry.errorMessage}` : ''
    const body =
      entry.report.text.length === 0
        ? '\nIt left no final message.'
        : `\nReport:\n${entry.report.text}${
            entry.report.truncated
              ? `\n[Report truncated. Full text: ari session read ${entry.sessionId} --json]`
              : ''
          }`
    return head + error + body
  })
  const waiting =
    stillWorking.length === 0
      ? 'No other children are working.'
      : `Still working: ${stillWorking
          .map((child) => `"${child.title}" (${child.sessionId})`)
          .join(', ')}. You will be told when they finish, so do not wait or poll for them.`
  return [
    '[Ari delegation update: added automatically by Ari, not written by the user.]',
    ...sections,
    `${waiting} Inspect changes with \`ari session diff <id> --stat --json\` before integrating; a finished turn is not proof the work is correct.`,
  ].join('\n\n')
}

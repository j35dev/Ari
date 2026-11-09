import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import type { RpcResults } from '@ari/contracts/rpc'
import { finalAssistantText } from './delegation-state'
import { helmRow, sessionState, type HelmView } from './helm'
import type { SessionReadModel } from './projection'

export type AriaOverview = RpcResults['aria.overview']

const LIMIT = 20
const DAY_MS = 24 * 3_600_000

function oneLine(text: string): string {
  return (text.trim().split(/\r?\n/, 1)[0] ?? '').trim().slice(0, 240)
}

function approvalSummary(approval: SessionReadModel['pendingApprovals'][number]): string {
  try {
    const summary: unknown = JSON.parse(approval.summaryJson)
    if (
      summary &&
      typeof summary === 'object' &&
      'title' in summary &&
      typeof summary.title === 'string'
    ) {
      const title = oneLine(summary.title)
      if (title) return title
    }
  } catch {
    // Older providers sometimes stored a plain-text summary; the tool still names the action.
  }
  return oneLine(approval.toolName)
}

/** The user's outstanding decisions and Aria's work across all projects. */
export async function ariaOverview(
  view: HelmView,
  aria: SessionReadModel,
  now = Date.now(),
): Promise<AriaOverview> {
  const needsYou: AriaOverview['needsYou'] = []
  const running: AriaOverview['running'] = []
  const doneToday: AriaOverview['doneToday'] = []
  const ariaIds = new Set(
    view.rows.filter((row) => row.projectId === HELM_PROJECT_ID).map((row) => row.id),
  )
  if (aria.session) ariaIds.add(aria.session.id)

  for (const row of view.rows) {
    if (row.archived || row.projectId === HELM_PROJECT_ID) continue
    const model = await view.load(row.id)
    if (!model.session || model.session.archived) continue
    // The journal decides the state; sidebar indexes can trail a turn.
    const state = sessionState(model)
    const completion = aria.childCompletions?.[row.id]
    const settledAt = completion?.settledAt
    const recent = settledAt !== undefined && settledAt <= now && now - settledAt < DAY_MS
    if (state === 'idle' && !recent) continue
    const entry = await helmRow({ ...view, load: () => Promise.resolve(model) }, row)
    const base = {
      sessionId: entry.sessionId,
      title: entry.title,
      projectId: entry.projectId,
      projectName: entry.projectName,
      updatedAt: row.updatedAt,
    }

    if (state === 'needs_user') {
      // Request timestamps are not projected, so recency follows the session's index.
      for (const approval of [...model.pendingApprovals].reverse()) {
        needsYou.push({
          ...base,
          requestId: approval.approvalId,
          kind: 'approval',
          summary: approvalSummary(approval),
        })
      }
      for (const question of [...model.pendingInputs].reverse()) {
        needsYou.push({
          ...base,
          requestId: question.inputId,
          kind: 'question',
          summary: oneLine(question.prompt),
        })
      }
    } else if (state === 'working' || state === 'queued') {
      const creator = model.session.createdBy
      running.push({
        ...base,
        state,
        startedByAria:
          entry.startedByAria && creator?.kind === 'session' && ariaIds.has(creator.sessionId),
        startedAt:
          model.activeTurnId === null
            ? null
            : (model.messages.find(
                (message) => message.role === 'user' && message.turnId === model.activeTurnId,
              )?.createdAt ?? null),
      })
    }

    if (recent && completion) {
      doneToday.push({
        ...base,
        settledAt,
        report: oneLine(finalAssistantText(model, completion.turnId).text),
      })
    }
  }

  needsYou.sort((a, b) => b.updatedAt - a.updatedAt)
  running.sort((a, b) => (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt))
  doneToday.sort((a, b) => b.settledAt - a.settledAt)
  return {
    needsYou: needsYou.slice(0, LIMIT),
    running: running.slice(0, LIMIT),
    doneToday: doneToday.slice(0, LIMIT),
    more: {
      needsYou: Math.max(0, needsYou.length - LIMIT),
      running: Math.max(0, running.length - LIMIT),
      doneToday: Math.max(0, doneToday.length - LIMIT),
    },
  }
}

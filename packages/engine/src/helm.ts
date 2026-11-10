import {
  HELM_PROJECT_ID,
  HELM_MAX_PROJECTS,
  HELM_DESCRIPTION_CHARS,
  HELM_RECENT_SESSIONS,
  HELM_SESSION_TITLE_CHARS,
  HELM_ERROR_MESSAGE_CHARS,
  type HelmProjectContext,
  type HelmSessionRow,
  isHelmSession,
  isHelmProjectSession,
} from '@ari/contracts/helm'
import type { SessionListEntry, SessionStore } from './session-store'
import type { SessionReadModel } from './projection'
import { finalAssistantText } from './delegation-state'
import type { ResolvedProjectAgent } from '@ari/contracts/project'

/**
 * The session whose instruction a turn answers, or null when a person asked.
 * A wake-up with children's results continues whatever started the work, so
 * Ari-written turns are walked past to the instruction behind them.
 */
export function turnRequester(model: SessionReadModel, turnId: string): string | null {
  const asks = model.messages.filter((message) => message.role === 'user')
  const start = asks.findIndex((message) => message.turnId === turnId)
  for (let i = start; i >= 0; i--) {
    const origin = asks[i]?.origin
    if (origin?.kind === 'session') return origin.sessionId
    if (origin?.kind !== 'completion' && origin?.kind !== 'question') return null
  }
  return null
}

/** A new Aria topic inherits reports from project sessions whose requester was deleted. */
export async function helmReportRecipient(
  store: Pick<SessionStore, 'loadExisting' | 'currentHelmSession'>,
  model: SessionReadModel,
  turnId: string,
): Promise<string | null> {
  return helmRecipient(store, model, turnRequester(model, turnId))
}

export async function helmTaskRecipient(
  store: Pick<SessionStore, 'loadExisting' | 'currentHelmSession'>,
  model: SessionReadModel,
  rows: readonly SessionListEntry[],
): Promise<string | null> {
  const queued = [...model.queuedMessages]
    .reverse()
    .find((message) => message.origin?.kind === 'session')
  const asked = [...model.messages]
    .reverse()
    .find((message) => message.role === 'user' && message.origin?.kind === 'session')
  const requester =
    queued?.origin?.kind === 'session'
      ? queued.origin.sessionId
      : asked?.origin?.kind === 'session'
        ? asked.origin.sessionId
        : model.session?.createdBy?.kind === 'session'
          ? model.session.createdBy.sessionId
          : null
  return helmRecipient(store, model, requester, rows)
}

async function helmRecipient(
  store: Pick<SessionStore, 'loadExisting' | 'currentHelmSession'>,
  model: SessionReadModel,
  requester: string | null,
  rows?: readonly SessionListEntry[],
): Promise<string | null> {
  if (!requester) return null
  const row = rows?.find((row) => row.id === requester)
  if (row) return isHelmSession(row) ? requester : null
  const asked = (await store.loadExisting(requester))?.session
  if (asked) return isHelmSession(asked) ? requester : null
  if (!isHelmProjectSession(model.session)) return null
  if (!rows) return store.currentHelmSession()
  const current = [...rows]
    .filter((row) => isHelmSession(row) && !row.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return current?.id ?? null
}

/** Where a session stands, from its journal. */
export function sessionState(model: SessionReadModel): HelmSessionRow['state'] {
  if (model.activeTurnId !== null)
    return model.pendingApprovals.length > 0 || model.pendingInputs.length > 0
      ? 'needs_user'
      : 'working'
  return model.queuedMessages.length > 0 ? 'queued' : 'idle'
}

/** Listing statuses that mean a turn is running or about to; cheap to read for every session. */
const ACTIVE = new Set(['queued', 'running', 'waiting-approval', 'waiting-input'])

export interface HelmView {
  rows: readonly SessionListEntry[]
  load(id: string): Promise<SessionReadModel>
  projectName(id: string): string | null
}

/** A session as Aria is shown it. */
export async function helmRow(view: HelmView, row: SessionListEntry): Promise<HelmSessionRow> {
  const model = await view.load(row.id)
  const session = model.session
  const lastTurn =
    model.activeTurnId === null && model.queuedMessages.length === 0 ? model.lastTurn : undefined
  const latestTurn: HelmSessionRow['latestTurn'] = lastTurn
    ? {
        turnId: lastTurn.turnId,
        stopReason: lastTurn.stopReason,
        settledAt: lastTurn.settledAt,
        errorMessage:
          lastTurn.stopReason === 'error' && lastTurn.errorMessage
            ? compact(lastTurn.errorMessage, HELM_ERROR_MESSAGE_CHARS) || null
            : null,
      }
    : null
  const previewTurnId = model.activeTurnId ?? latestTurn?.turnId
  const preview = previewTurnId ? finalAssistantText(model, previewTurnId, 240).text : ''
  return {
    sessionId: row.id,
    title: row.title,
    projectId: row.projectId,
    projectName: view.projectName(row.projectId),
    parentSessionId: row.parentSessionId ?? null,
    driverKind: row.driverKind ?? session?.driverKind ?? 'unknown',
    modelId: row.modelId ?? session?.modelId ?? null,
    state: sessionState(model),
    latestTurn,
    startedByAria: Boolean(
      session && !session.parentSessionId && session.createdBy?.kind === 'session',
    ),
    updatedAt: model.lastTurn?.settledAt ?? row.updatedAt,
    preview: preview.length > 0 ? preview : null,
  }
}

/** Sessions outside Aria's own project that are not archived. */
function reachable(view: HelmView): SessionListEntry[] {
  return view.rows.filter((row) => !row.archived && row.projectId !== HELM_PROJECT_ID)
}

export interface FindSessions {
  query?: string | undefined
  projectId?: string | undefined
  scope: 'active' | 'all'
  limit: number
}

/**
 * Sessions across every project for Aria to find work again. Words match the
 * title or the last reply. Only the sessions that pass are loaded.
 */
export async function findSessions(view: HelmView, find: FindSessions): Promise<HelmSessionRow[]> {
  const words = (find.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const out: HelmSessionRow[] = []
  for (const row of reachable(view)) {
    if (out.length >= find.limit) break
    if (find.projectId !== undefined && row.projectId !== find.projectId) continue
    if (find.scope === 'active' && !ACTIVE.has(row.status ?? 'idle')) continue
    const haystack = `${row.title} ${row.lastMessagePreview ?? ''}`.toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue
    const entry = await helmRow(view, row)
    // The listing can trail the journal by a turn; the journal decides.
    if (find.scope === 'active' && entry.state === 'idle') continue
    out.push(entry)
  }
  return out
}

const STATE = {
  working: 'working',
  queued: 'queued',
  needs_user: 'waiting on the user',
  idle: 'idle',
} as const

const OUTCOME = {
  completed: 'completed',
  interrupted: 'interrupted',
  error: 'failed',
} as const

function ago(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function line(entry: HelmSessionRow, titles: ReadonlyMap<string, string>): string {
  const where = entry.projectName ?? entry.projectId
  const parent = entry.parentSessionId ? titles.get(entry.parentSessionId) : undefined
  const under = parent ? `, child of "${parent}"` : ''
  const mine = entry.startedByAria ? ', started by you' : ''
  const settled = entry.state === 'idle' ? entry.latestTurn : null
  const state = settled ? OUTCOME[settled.stopReason] : STATE[entry.state]
  const error = settled?.errorMessage ? `: ${settled.errorMessage}` : ''
  return `- "${entry.title}" (${entry.sessionId}) in ${where}${under}${mine}: ${state}${error}`
}

const MAX_ACTIVE = 25
const MAX_FINISHED = 8
const DAY_MS = 24 * 3_600_000

function compact(text: string, max: number): string {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function projectLine(
  p: HelmProjectContext & {
    projectId: string
    name: string
    available: boolean
    agent?: ResolvedProjectAgent | null
    agentError?: string
  },
): string {
  const source = {
    arguments: 'explicit choice',
    project: 'project setting',
    lead: 'current lead',
  } as const
  const agent = p.agentError
    ? ', saved default is missing a model; ask the user'
    : p.agent
      ? `, ${p.agent.driverKind}/${p.agent.modelId}${p.agent.effort ? ` ${p.agent.effort}` : ''}, ${source[p.agent.source]}`
      : p.agent === null
        ? ', agent unset'
        : ''
  const clues = [
    ...(p.description ? [compact(p.description, HELM_DESCRIPTION_CHARS)] : []),
    ...(p.repository ? [`repo: ${compact(p.repository, 100)}`] : []),
    ...(p.recentSessionTitles?.length
      ? [
          `recent: ${p.recentSessionTitles
            .slice(0, HELM_RECENT_SESSIONS)
            .map((title) => JSON.stringify(compact(title, HELM_SESSION_TITLE_CHARS)))
            .join(' / ')}`,
        ]
      : []),
  ]
  return `- ${compact(p.name, 80)} (${p.projectId}${agent}${p.available ? '' : ', folder missing'})${clues.length ? ` — ${clues.join('; ')}` : ''}`
}

/**
 * What Aria is told at the start of every turn: the projects it can reach,
 * what is running across them, and which of the sessions it asked for work
 * finished in the last day. It saves a status call on every turn and keeps
 * Aria from starting work that already exists.
 */
export async function helmSnapshot(
  view: HelmView,
  helm: SessionReadModel,
  projects: readonly (HelmProjectContext & {
    projectId: string
    name: string
    available: boolean
    agent?: ResolvedProjectAgent | null
    agentError?: string
  })[],
  now = Date.now(),
): Promise<string> {
  const rows = reachable(view)
  const titles = new Map(rows.map((row) => [row.id, row.title]))
  const active: HelmSessionRow[] = []
  for (const row of rows) {
    if (active.length >= MAX_ACTIVE) break
    if (!ACTIVE.has(row.status ?? 'idle')) continue
    const entry = await helmRow(view, row)
    if (entry.state !== 'idle') active.push(entry)
  }
  const reported = Object.entries(helm.childCompletions ?? {})
    .filter(([, completion]) => now - (completion.settledAt ?? 0) < DAY_MS)
    .sort(([, a], [, b]) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
  const finished: HelmSessionRow[] = []
  for (const [id] of reported) {
    if (finished.length >= MAX_FINISHED) break
    const row = rows.find((candidate) => candidate.id === id)
    if (!row) continue
    const entry = await helmRow(view, row)
    if (entry.state === 'idle') finished.push(entry)
  }
  const others = projects
    .filter((project) => project.projectId !== HELM_PROJECT_ID)
    .sort(
      (a, b) =>
        Number(Boolean(b.open)) - Number(Boolean(a.open)) ||
        Number(Boolean(b.lastViewed)) - Number(Boolean(a.lastViewed)) ||
        (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
    )
  const lastViewed = others.find((project) => project.lastViewed)
  const projectBlock =
    others.length === 0
      ? 'Projects: none yet. Use `ari project create` when the user asks to build something new.'
      : `Projects:\n${others.slice(0, HELM_MAX_PROJECTS).map(projectLine).join('\n')}${others.length > HELM_MAX_PROJECTS ? `\n(${others.length - HELM_MAX_PROJECTS} more; use ari projects to list all.)` : ''}`
  return [
    "[Ari now: the live state of the user's projects, added automatically by Ari for Aria. The user does not see this.]",
    projectBlock,
    ...(lastViewed
      ? [`You were last in ${compact(lastViewed.name, 80)} (${lastViewed.projectId}).`]
      : []),
    active.length === 0
      ? 'Nothing is running.'
      : `Running now:\n${active.map((entry) => line(entry, titles)).join('\n')}`,
    ...(finished.length === 0
      ? []
      : [
          `Finished in the last day, from work you asked for:\n${finished
            .map((entry) => `${line(entry, titles)}, ${ago(now - entry.updatedAt)}`)
            .join('\n')}`,
        ]),
  ].join('\n\n')
}

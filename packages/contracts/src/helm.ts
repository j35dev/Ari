import type { ChildWorkState } from './agent-control'

/**
 * Aria runs sessions in the user's projects, with leads available on request.
 * Its own sessions use a built-in home under Ari's data directory;
 * membership of that home identifies Aria independently of its UI.
 *
 * In code it goes by its code name, Helm (`isHelmSession`, `HELM_PROJECT_ID`),
 * so a search for it never wades through the renderer's `aria-*` attributes.
 */
export const HELM_PROJECT_ID = 'helm'
export const HELM_NAME = 'Aria'
export const HELM_MAX_PROJECTS = 15
export const HELM_DESCRIPTION_CHARS = 100
export const HELM_RECENT_SESSIONS = 3
export const HELM_SESSION_TITLE_CHARS = 80

/** Compact routing clues gathered by the desktop, without reading folders during a turn. */
export interface HelmProjectContext {
  description?: string | null
  repository?: string | null
  recentSessionTitles?: readonly string[]
  open?: boolean
  lastOpenedAt?: number
  lastViewed?: boolean
}

export function isHelmSession(session: { projectId: string } | null | undefined): boolean {
  return session?.projectId === HELM_PROJECT_ID
}

/** Only Aria creates top-level project sessions with a session creator. */
export function isHelmProjectSession(
  session:
    | {
        projectId: string
        parentSessionId?: string | null
        lead?: boolean
        createdBy?: { kind: string } | null
      }
    | null
    | undefined,
): boolean {
  return Boolean(
    session &&
    !isHelmSession(session) &&
    !session.parentSessionId &&
    session.createdBy?.kind === 'session',
  )
}

/** Project leads survive the Aria chat that created them. */
export function isHelmProjectLead(session: Parameters<typeof isHelmProjectSession>[0]): boolean {
  return isHelmProjectSession(session) && session?.lead === true
}

/** These coordinators can carry their conversation to a different provider. */
export function canSwitchProvider(session: Parameters<typeof isHelmProjectSession>[0]): boolean {
  return isHelmSession(session) || isHelmProjectSession(session)
}

/** Aria has its own entry point, outside the project's navigation surfaces. */
export function visibleProjects<T extends { id: string }>(projects: readonly T[]): T[] {
  return projects.filter((project) => project.id !== HELM_PROJECT_ID)
}

export function visibleSessions<T extends { projectId: string }>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isHelmSession(session))
}

/** One session as Aria's `sessions find` reports it. */
export interface HelmSessionRow {
  sessionId: string
  title: string
  projectId: string
  projectName: string | null
  parentSessionId: string | null
  driverKind: string
  modelId: string | null
  state: 'working' | 'queued' | 'needs_user' | 'needs_agent' | 'idle'
  workState?: ChildWorkState
  lastSeq?: number
  questionOwnerSessionId?: string | null
  pendingInputs?: { inputId: string; prompt: string; choicesJson: string | null }[]
  pendingApprovals?: { approvalId: string; toolName: string; summaryJson: string }[]
  /** Started by Aria, so its reports come back to Aria. */
  startedByAria: boolean
  updatedAt: number
  /** The start of the session's last assistant message. */
  preview: string | null
}

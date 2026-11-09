/**
 * Aria coordinates the user's projects through one long-lived lead per
 * project. Its own sessions use a built-in home under Ari's data directory;
 * membership of that home identifies Aria independently of its UI.
 *
 * In code it goes by its code name, Helm (`isHelmSession`, `HELM_PROJECT_ID`),
 * so a search for it never wades through the renderer's `aria-*` attributes.
 */
export const HELM_PROJECT_ID = 'helm'
export const HELM_NAME = 'Aria'

export function isHelmSession(session: { projectId: string } | null | undefined): boolean {
  return session?.projectId === HELM_PROJECT_ID
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
  state: 'working' | 'queued' | 'needs_user' | 'idle'
  /** Started by Aria, so its reports come back to Aria. */
  startedByAria: boolean
  updatedAt: number
  /** The start of the session's last assistant message. */
  preview: string | null
}

import type { SessionCreateParams } from '@ari/contracts/rpc'
import type { Session, SessionWorkspace } from '@ari/contracts/session'

export interface SessionCreateDeps {
  loadProject: (projectId: string) => Promise<unknown>
  createSession: (session: Session) => Promise<void>
  prepareRootWorkspace?: (session: Session, mode?: 'auto' | 'isolated' | 'shared') => Promise<SessionWorkspace>
}

export async function createSession(
  deps: SessionCreateDeps,
  params: SessionCreateParams,
): Promise<{ sessionId: string }> {
  // A session always runs inside a project: without one there is no workspace
  // to jail the terminal and file tools against. The renderer resolves a
  // project before it gets here, so a miss means a caller skipped that step —
  // fail loudly rather than minting another Unfiled session.
  await deps.loadProject(params.projectId)
  const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const session: Session = {
    id: sessionId,
    projectId: params.projectId,
    title: params.title,
    driverKind: params.driverKind,
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    ...(params.effort !== undefined ? { effort: params.effort } : {}),
    ...(params.lead === true ? { lead: true as const } : {}),
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  if (deps.prepareRootWorkspace)
    session.workspace = await deps.prepareRootWorkspace(session, params.workspaceMode)
  await deps.createSession(session)
  return { sessionId }
}

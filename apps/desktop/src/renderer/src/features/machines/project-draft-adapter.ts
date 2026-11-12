import { createHostDraftClient } from '../session/session-draft-client'
import type { ProjectDraftClient } from './ProjectDraft'
import { createSessionClient } from '../session/session-client'
import type { AttachmentRef } from '@ari/contracts/attachments'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import type { ProjectAgent } from '@ari/contracts/project'
import { rpc } from '../../lib/rpc'

/** Translate shell presentation into the session owner's fixed host facade. */
export function remoteProjectDraftClient(machineId: string, draftId: string): ProjectDraftClient {
  const client = createHostDraftClient(machineId, draftId)
  return {
    catalog: client.catalog, workspaces: client.workspaces,
    create: ({ projectId, title, pick, workspaceToken, workspaceMode }) => client.create({
      projectId, title, ...pick, ...(workspaceToken ? { workspaceToken } : {}), workspaceMode: workspaceMode ?? 'auto',
    }),
    stage: async (scope, files) => (await client.stage(scope, files)).map((ref) => ref.id),
    prompt: async (scope, { text, attachmentIds }) => { await client.firstPrompt(scope, text, attachmentIds) },
    checkCreate: () => client.checkCreation(),
    checkPrompt: async (_draftId, scope) => { await client.checkPrompt(scope); return true },
  }
}

/** Local creation retains the shell's existing F occupancy/reuse and unknown-start guards. */
export function localProjectDraftClient(options: {
  catalog: () => Promise<RemoteModelCatalog>
  create: (projectId: string, pick: ProjectAgent, workspaceMode: 'auto' | 'isolated' | 'shared') => Promise<string>
}): ProjectDraftClient {
  const attachments = new Map<string, AttachmentRef[]>()
  return {
    catalog: options.catalog,
    workspaces: async (projectId) => ({ projectId, truncated: false, options: [
      { token: 'isolated', label: 'New isolated worktree', kind: 'worktree', branch: null, workspaceMode: 'isolated' },
    ] }),
    create: async ({ projectId, pick, workspaceMode }) => ({ kind: 'local',
      sessionId: await options.create(projectId, pick, workspaceMode ?? 'auto') }),
    stage: async (scope, files) => {
      if (scope.kind !== 'local') throw new Error('This draft belongs to This PC.')
      const refs = await createSessionClient(scope).stageImages(files)
      attachments.set(scope.sessionId, refs)
      return refs.map((ref) => ref.id)
    },
    prompt: async (scope, { text, attachmentIds }) => {
      if (scope.kind !== 'local') throw new Error('This draft belongs to This PC.')
      const refs = attachments.get(scope.sessionId) ?? []
      if (attachmentIds.some((id) => !refs.some((ref) => ref.id === id))) throw new Error('Draft images must be reattached on This PC.')
      const result = await createSessionClient(scope).invoke('command.dispatch', {
        command: { type: 'turn.start', sessionId: scope.sessionId, text, attachments: refs },
      })
      if (!result.accepted) throw new Error(result.reason ?? 'The first prompt was refused.')
    },
    checkCreate: async () => {
      await rpc.invoke('session.list')
      throw new Error('Local creation is still unconfirmed. Inspect the refreshed session list before starting another.')
    },
    checkPrompt: async (_draftId, scope) => {
      if (scope.kind !== 'local') throw new Error('This draft belongs to This PC.')
      await createSessionClient(scope).invoke('session.load', { sessionId: scope.sessionId })
      return false
    },
  }
}

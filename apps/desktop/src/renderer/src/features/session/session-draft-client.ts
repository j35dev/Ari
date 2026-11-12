import { z } from 'zod'
import {
  remoteDesktopCommandSchema, remoteDesktopCommandResultSchemas, remoteDesktopQueryResultSchemas,
  remoteModelCatalogSchema, type RemoteModelCatalog, type RemoteProjectCatalog, type RemoteProjectWorkspaces,
} from '@ari/contracts/remote'
import { remoteQuery, sendRemote, readReceipt, resolveReceipt, type RemoteReceipt } from '../machines/remote-client'
import { assertMachineOperation, machineEpoch } from './session-machine-access'
import { createSessionClient, type SessionScope } from './session-client'

export type HostDraftSelection = Omit<Extract<z.infer<typeof remoteDesktopCommandSchema>, { op: 'session.desktop.create' }>, 'op' | 'clientCommandId' | 'idempotencyKey'>
export interface HostDraftClient {
  readonly machineId: string
  readonly draftId: string
  readonly receiptScope: string
  catalog(): Promise<RemoteModelCatalog>
  projects(): Promise<RemoteProjectCatalog>
  workspaces(projectId: string): Promise<RemoteProjectWorkspaces>
  receipt(): RemoteReceipt | null
  create(selection: HostDraftSelection): Promise<SessionScope>
  checkCreation(): Promise<SessionScope>
  stage(scope: SessionScope, files: File[]): ReturnType<ReturnType<typeof createSessionClient>['stageImages']>
  firstPrompt(scope: SessionScope, text: string, attachmentIds?: string[]): Promise<unknown>
  checkPrompt(scope: SessionScope): Promise<unknown>
}

/** No durable session is created until the shell sends; uncertain creation never mints another key. */
export function createHostDraftClient(machineId: string, draftId: string): HostDraftClient {
  if (!machineId || !draftId) throw new Error('A host draft requires stable machine and draft ids.')
  const receiptScope = `draft:${draftId}`
  const sessionScope = (value: unknown): SessionScope => ({ kind: 'remote', machineId,
    sessionId: remoteDesktopCommandResultSchemas['session.desktop.create'].parse(value).sessionId })
  const assertScope = (scope: SessionScope): void => {
    if (scope.kind !== 'remote' || scope.machineId !== machineId) throw new Error('This draft belongs to another machine.')
  }
  const read = async (query: Parameters<typeof remoteQuery>[1]) => {
    const epoch = await assertMachineOperation(machineId, query.op)
    const value = await remoteQuery(machineId, query)
    if (epoch !== machineEpoch(machineId)) throw new Error('Access changed while reading draft options.')
    return value
  }
  return Object.freeze({
    machineId, draftId, receiptScope,
    catalog: async () => remoteModelCatalogSchema.parse(await read({ op: 'models.list' })),
    projects: async () => remoteDesktopQueryResultSchemas['project.catalog'].parse(await read({ op: 'project.catalog' })),
    workspaces: async (projectId: string) => remoteDesktopQueryResultSchemas['project.workspaces'].parse(await read({ op: 'project.workspaces', projectId })),
    receipt: () => readReceipt(machineId, receiptScope),
    async create(selection: HostDraftSelection) {
      await assertMachineOperation(machineId, 'session.desktop.create')
      return sessionScope(await sendRemote(machineId, receiptScope, { op: 'session.desktop.create', ...selection }))
    },
    async checkCreation() {
      await assertMachineOperation(machineId, 'command.status')
      return sessionScope(await resolveReceipt(machineId, receiptScope))
    },
    async stage(scope: SessionScope, files: File[]) { assertScope(scope); return createSessionClient(scope).stageImages(files) },
    async firstPrompt(scope: SessionScope, text: string, attachmentIds?: string[]) {
      assertScope(scope)
      await assertMachineOperation(machineId, 'session.prompt')
      return sendRemote(machineId, scope.sessionId, { op: 'session.prompt', sessionId: scope.sessionId, text, attachmentIds })
    },
    async checkPrompt(scope: SessionScope) {
      assertScope(scope)
      await assertMachineOperation(machineId, 'command.status')
      return resolveReceipt(machineId, scope.sessionId)
    },
  })
}
export const createSessionDraftClient = createHostDraftClient

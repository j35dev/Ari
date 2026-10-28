import type { Bot, BotCreateParams } from '@ari/contracts/bot'
import type { PermissionMode } from '@ari/contracts/common'
import type { SessionCreateParams } from '@ari/contracts/rpc'
import type { Session } from '@ari/contracts/session'
import type { BotStore } from '@ari/engine/bots'

export interface SessionCreateDeps {
  bots: Pick<BotStore, 'get' | 'create' | 'update'>
  loadProject: (projectId: string) => Promise<unknown>
  createSession: (session: Session) => Promise<void>
  defaultPermissionMode: () => PermissionMode
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
  if (params.botId !== undefined && (await deps.bots.get(params.botId)) === null) {
    throw new Error(`unknown bot: ${params.botId}`)
  }
  const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  await deps.createSession({
    id: sessionId,
    projectId: params.projectId,
    title: params.title,
    driverKind: params.driverKind,
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    ...(params.effort !== undefined ? { effort: params.effort } : {}),
    ...(params.botId !== undefined ? { botId: params.botId } : {}),
    ...(params.lead === true ? { lead: true as const } : {}),
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return { sessionId }
}

/**
 * If the main session cannot be created the bot stays, without `mainSessionId`;
 * there is no bot delete to roll back with.
 */
export async function createBot(deps: SessionCreateDeps, params: BotCreateParams): Promise<Bot> {
  await deps.loadProject(params.projectId)
  const bot = await deps.bots.create(params)
  const { sessionId } = await createSession(deps, {
    projectId: params.projectId,
    title: bot.name,
    driverKind: bot.driverKind,
    modelId: bot.modelId,
    permissionMode: deps.defaultPermissionMode(),
    botId: bot.id,
  })
  return deps.bots.update(bot.id, { mainSessionId: sessionId })
}

import type { DriverKind, PermissionMode, ApprovalOption } from '@ari/contracts/common'
import { exceedsPermission, driverKindSchema } from '@ari/contracts/common'
import type { ExternalSource } from '@ari/contracts/external'
import type { Project, ResolvedProjectAgent } from '@ari/contracts/project'
import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import { resolveProjectAgentSelection, type ProjectAgentProvider } from '@ari/engine/projects'
import { resolveLaunchEffort, type LaunchEffortOption } from '@ari/engine/launch-effort'
import { finalAssistantText, pendingCompletions } from '@ari/engine/delegation-state'
import type { SessionStore } from '@ari/engine/session-store'
import type { ChildTask } from '@ari/contracts/agent-control'
import type { SlackSnapshot } from '@ari/contracts/slack'
import type { Session } from '@ari/contracts/session'
import type { Engine } from '../engine'
import { createSession, type SessionCreateDeps } from '../session-create'

export class ExternalTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface ExternalPendingRequest {
  kind: 'approval' | 'input'
  sessionId: string
  turnId: string
  id: string
  prompt: string
  choicesJson: string | null
  options: ApprovalOption[]
  available: boolean
}

export interface ExternalTaskView {
  sessionId: string
  projectId: string
  connectorId: string | null
  title: string
  permissionMode: PermissionMode
  archived: boolean
  activeTurnId: string | null
  queued: number
  workingChildren: number
  pending: ExternalPendingRequest[]
  lastTurn: {
    id: string
    outcome: 'completed' | 'interrupted' | 'error'
    text: string
    error: string | null
  } | null
  seq: number
}

export interface ExternalTaskHost {
  projects(): Promise<SlackSnapshot['projects']>
  catalog(): Promise<SlackSnapshot['providers']>
  create(
    input: {
      sessionId: string
      projectId: string
      text: string
      source: ExternalSource
      permissionMode: PermissionMode
    },
    guard: () => void,
  ): Promise<ResolvedProjectAgent>
  view(sessionId: string, projectId: string): Promise<ExternalTaskView | null>
  hasRequest(sessionId: string, requestId: string): Promise<boolean>
  prompt(
    sessionId: string,
    projectId: string,
    text: string,
    source: ExternalSource,
    ceiling: PermissionMode,
    guard: () => void,
  ): Promise<{ queued: boolean }>
  stop(
    sessionId: string,
    projectId: string,
    ceiling: PermissionMode,
    guard: () => void,
  ): Promise<void>
  answer(
    rootId: string,
    projectId: string,
    request: ExternalPendingRequest,
    value: string,
    ceiling: PermissionMode,
    guard: () => void,
  ): Promise<void>
  subscribe(onChanged: () => void): () => void
}

export function createExternalTaskHost(deps: {
  engine: Engine
  store: SessionStore
  sessionDeps: SessionCreateDeps
  projects: () => Promise<readonly Project[]>
  providers: () => Promise<readonly ProjectAgentProvider[]>
  efforts: (kind: DriverKind, modelId: string | null) => Promise<readonly LaunchEffortOption[]>
  tasks?: (sessionId: string) => Promise<ChildTask[]>
}): ExternalTaskHost {
  async function requireSession(id: string, projectId: string, ceiling?: PermissionMode) {
    const model = await deps.store.loadExisting(id)
    const session = model?.session
    if (!model || !session || session.projectId !== projectId || projectId === HELM_PROJECT_ID)
      throw new ExternalTaskError('not_found', 'This Slack task is no longer available in Ari.')
    if (session.archived)
      throw new ExternalTaskError(
        'archived',
        'This task is archived. Restore it in Ari before continuing.',
      )
    if (ceiling && exceedsPermission(session.permissionMode, ceiling))
      throw new ExternalTaskError(
        'permission_denied',
        'The session permission mode exceeds this Slack connection. Review it in Ari.',
      )
    return model
  }

  function guarded(projectId: string, ceiling: PermissionMode, guard: () => void) {
    return (session: Session) => {
      guard()
      if (
        session.projectId !== projectId ||
        session.archived ||
        exceedsPermission(session.permissionMode, ceiling)
      )
        throw new ExternalTaskError(
          'permission_denied',
          'This task changed or exceeds the Slack connection permissions. Review it in Ari.',
        )
    }
  }

  return {
    async projects() {
      const [projects, providers] = await Promise.all([deps.projects(), deps.providers()])
      return projects
        .filter((project) => project.id !== HELM_PROJECT_ID)
        .map((project) => {
          const selection = resolveProjectAgentSelection({
            project: { projectId: project.id, defaultAgent: project.defaultAgent },
            providers,
            app: { permissionMode: 'ask' },
          })
          const reason =
            project.status !== 'ok'
              ? 'Project folder is unavailable.'
              : selection.error?.reason === 'model_required'
                ? 'Save a default provider and model for this project in Ari.'
                : selection.error
                  ? 'The saved provider or model is unavailable on this machine.'
                  : null
          return {
            id: project.id,
            name: project.name,
            ready: reason === null,
            reason,
            defaultAgent: project.defaultAgent ?? null,
          }
        })
    },

    async catalog() {
      return (await deps.providers()).flatMap((provider) => {
        const kind = driverKindSchema.safeParse(provider.driverKind)
        return kind.success
          ? [
              {
                driverKind: kind.data,
                available: provider.available,
                models: provider.models.map((model) => ({
                  id: model.id,
                  efforts: model.efforts?.map((effort) => effort.id) ?? [],
                })),
              },
            ]
          : []
      })
    },

    async create(input, guard) {
      guard()
      const existing = await deps.store.loadExisting(input.sessionId)
      if (existing?.session) {
        const session = existing.session
        if (
          session.projectId !== input.projectId ||
          session.externalSource?.requestId !== input.source.requestId
        )
          throw new ExternalTaskError(
            'conflict',
            'The reserved task identity belongs to another request.',
          )
        return {
          driverKind: session.driverKind,
          modelId: session.modelId,
          effort: session.effort ?? null,
          permissionMode: session.permissionMode,
          source: 'project',
        }
      }
      const project = (await deps.projects()).find(
        (project) => project.id === input.projectId && project.id !== HELM_PROJECT_ID,
      )
      if (!project || project.status !== 'ok')
        throw new ExternalTaskError(
          'project_unavailable',
          'The configured project folder is unavailable. Review the Slack channel mapping in Ari.',
        )
      const resolved = resolveProjectAgentSelection({
        project: { projectId: project.id, defaultAgent: project.defaultAgent },
        providers: await deps.providers(),
        app: { permissionMode: 'ask' },
        maxPermissionMode: input.permissionMode,
      })
      if (!resolved.agent)
        throw new ExternalTaskError(
          resolved.error.reason,
          resolved.error.reason === 'model_required'
            ? `Save a default provider and model for ${project.name} in Ari before starting Slack tasks.`
            : `The saved provider or model for ${project.name} is unavailable. Restore that choice in Ari and send a new request.`,
        )
      const agent = resolved.agent
      const effort = resolveLaunchEffort({
        baseline: agent.effort,
        text: input.text,
        options: await deps.efforts(agent.driverKind, agent.modelId),
      })
      agent.effort = effort.resolved
      await createSession(
        deps.sessionDeps,
        {
          projectId: project.id,
          title: `Slack · ${input.text.replace(/\s+/g, ' ').slice(0, 90)}`,
          driverKind: agent.driverKind,
          modelId: agent.modelId,
          effort: agent.effort,
          permissionMode: agent.permissionMode,
          workspaceMode: 'isolated',
        },
        { sessionId: input.sessionId, externalSource: input.source, admissionGuard: guard },
      )
      return agent
    },

    async view(sessionId, projectId) {
      const model = await deps.store.loadExisting(sessionId)
      const session = model?.session
      if (!model || !session || session.projectId !== projectId || projectId === HELM_PROJECT_ID)
        return null
      const tasks = (await deps.tasks?.(sessionId)) ?? []
      const agentOwnedInputs = new Set(
        tasks.filter((task) => task.questionOwnerSessionId !== null).map((task) => task.sessionId),
      )
      const models = [model]
      for (const task of tasks) {
        const child = await deps.store.loadExisting(task.sessionId)
        if (child?.session?.projectId === projectId && !child.session.archived) models.push(child)
      }
      const pending: ExternalPendingRequest[] = []
      for (const item of models) {
        if (!item.activeTurnId || !item.session) continue
        const capabilities = deps.engine.liveCapabilities(item.session.id)
        for (const approval of item.pendingApprovals)
          pending.push({
            kind: 'approval',
            sessionId: item.session.id,
            turnId: item.activeTurnId,
            id: approval.approvalId,
            prompt: `${approval.toolName}\n${approval.summaryJson.slice(0, 1800)}`,
            choicesJson: null,
            options: approval.options,
            available: capabilities.approval || approval.approvalId.startsWith('ari_delegate_'),
          })
        for (const input of agentOwnedInputs.has(item.session.id) ? [] : item.pendingInputs)
          pending.push({
            kind: 'input',
            sessionId: item.session.id,
            turnId: item.activeTurnId,
            id: input.inputId,
            prompt: input.prompt,
            choicesJson: input.choicesJson,
            options: [],
            available: capabilities.question,
          })
      }
      return {
        sessionId,
        projectId,
        connectorId: session.externalSource?.connectorId ?? null,
        title: session.title,
        permissionMode: session.permissionMode,
        archived: session.archived === true,
        activeTurnId: model.activeTurnId,
        queued: model.queuedMessages.length,
        workingChildren:
          tasks.filter((task) => !['result_available', 'not_started'].includes(task.workState))
            .length + pendingCompletions(model).length,
        pending,
        lastTurn: model.lastTurn
          ? {
              id: model.lastTurn.turnId,
              outcome: model.lastTurn.stopReason,
              text: finalAssistantText(model, model.lastTurn.turnId, 7000).text,
              error: model.lastTurn.errorMessage ?? null,
            }
          : null,
        seq: model.lastSeq,
      }
    },

    async hasRequest(sessionId, requestId) {
      const model = await deps.store.loadExisting(sessionId)
      return (
        model?.messages.some(
          (message) => message.role === 'user' && message.externalSource?.requestId === requestId,
        ) === true ||
        model?.queuedMessages.some((message) => message.externalSource?.requestId === requestId) ===
          true
      )
    },

    async prompt(sessionId, projectId, text, source, ceiling, guard) {
      const model = await requireSession(sessionId, projectId, ceiling)
      const result = await deps.engine.dispatch(
        { type: 'message.enqueue', sessionId, text, attachments: [], externalSource: source },
        undefined,
        guarded(projectId, ceiling, guard),
      )
      if (!result.accepted)
        throw new ExternalTaskError(
          'rejected',
          'Ari could not accept this follow-up. Inspect the session in Ari.',
        )
      return { queued: model.activeTurnId !== null }
    },

    async stop(sessionId, projectId, ceiling, guard) {
      const model = await requireSession(sessionId, projectId, ceiling)
      if (!model.activeTurnId) return
      const result = await deps.engine.dispatch(
        { type: 'turn.interrupt', sessionId },
        undefined,
        guarded(projectId, ceiling, guard),
      )
      if (!result.accepted)
        throw new ExternalTaskError(
          'rejected',
          'The active turn changed. Check the task status before stopping it again.',
        )
    },

    async answer(rootId, projectId, request, value, ceiling, guard) {
      await requireSession(rootId, projectId, ceiling)
      if (request.sessionId !== rootId) {
        const tasks = (await deps.tasks?.(rootId)) ?? []
        if (!tasks.some((task) => task.sessionId === request.sessionId))
          throw new ExternalTaskError('not_found', 'This request is outside the Slack task.')
      }
      const model = await requireSession(request.sessionId, projectId, ceiling)
      if (model.activeTurnId !== request.turnId)
        throw new ExternalTaskError(
          'stale',
          'This request belongs to an older turn. Use the current request in the thread.',
        )
      const result = await deps.engine.dispatch(
        request.kind === 'approval'
          ? {
              type: 'approval.respond',
              sessionId: request.sessionId,
              approvalId: request.id,
              optionId: value,
              expectedTurnId: request.turnId,
            }
          : {
              type: 'input.respond',
              sessionId: request.sessionId,
              inputId: request.id,
              value,
              expectedTurnId: request.turnId,
            },
        undefined,
        guarded(projectId, ceiling, guard),
      )
      if (!result.accepted)
        throw new ExternalTaskError(
          'stale',
          'This request was answered or its provider callback is unavailable. Review it in Ari.',
        )
    },

    subscribe(onChanged) {
      return deps.store.subscribe((event) => {
        if (
          event.type !== 'assistant.parts.appended' &&
          event.type !== 'usage.recorded' &&
          event.type !== 'context.recorded'
        )
          onChanged()
      })
    },
  }
}

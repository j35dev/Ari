import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { DiscoveredProject, Project } from '@ari/contracts/project'
import type { Settings, SettingsUpdate } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { err, ok, type Result } from '@ari/shared/result'
import { rpc } from '../../lib/rpc'
import { projectPathKey } from './project-path-key'

const log = createLogger('onboarding:finish')

export interface OnboardingChoice {
  projects: readonly DiscoveredProject[]
  driverKind: DriverKind | null
  permissionMode: PermissionMode
  createSession: boolean
}

export interface OnboardingOutcome {
  sessionId: string | null
  driverKind: DriverKind | null
}

export interface OnboardingFailure {
  stage: 'projects' | 'session' | 'settings' | 'cancelled'
  message: string
  failedPaths: string[]
}

type Outcome = Result<OnboardingOutcome, OnboardingFailure>

/** Keeps successful work across retries and writes completion only after every chosen step succeeds. */
export function createOnboardingCompletion(
  saveSettings: (patch: SettingsUpdate) => Promise<Settings>,
): (choice: OnboardingChoice, signal: AbortSignal) => Promise<Outcome> {
  const opened = new Map<string, Project>()
  const sessions = new Map<string, string>()
  let pending: Promise<Outcome> | null = null
  let completed: OnboardingOutcome | null = null
  const cancelled = (): Outcome =>
    err({ stage: 'cancelled', message: 'Setup was closed.', failedPaths: [] })

  const finish = async (choice: OnboardingChoice, signal: AbortSignal): Promise<Outcome> => {
    const selected = [...new Map(choice.projects.map((p) => [projectPathKey(p.path), p])).values()]
    const failed: DiscoveredProject[] = []
    for (const project of selected) {
      if (signal.aborted) return cancelled()
      const key = projectPathKey(project.path)
      if (opened.has(key)) continue
      try {
        const saved = await rpc.invoke('project.open', { path: project.path })
        if (saved.status === 'missing') failed.push(project)
        else opened.set(key, saved)
      } catch (error) {
        log.warn('selected project could not be opened', { path: project.path, error })
        failed.push(project)
      }
    }
    if (signal.aborted) return cancelled()
    if (failed.length > 0)
      return err({
        stage: 'projects',
        message: `Could not add ${failed.map((p) => p.name).join(', ')}. Check these folders and retry. Successfully added projects are kept.`,
        failedPaths: failed.map((p) => p.path),
      })

    let sessionId: string | null = null
    const first = selected[0]
    const project = first ? opened.get(projectPathKey(first.path)) : undefined
    if (choice.createSession && choice.driverKind !== null && project) {
      const key = JSON.stringify([project.id, choice.driverKind, choice.permissionMode])
      sessionId = sessions.get(key) ?? null
      if (sessionId === null) {
        try {
          const created = await rpc.invoke('session.create', {
            projectId: project.id,
            title: 'New session',
            driverKind: choice.driverKind,
            modelId: null,
            permissionMode: choice.permissionMode,
          })
          sessionId = created.sessionId
          sessions.set(key, sessionId)
        } catch (error) {
          log.warn('first session could not be created', error)
          return err({
            stage: 'session',
            message:
              'Your projects are added, but the first session could not be created. Retry or continue without a session.',
            failedPaths: [],
          })
        }
      }
    }
    if (signal.aborted) return cancelled()
    try {
      await saveSettings({
        onboarding: { completedAt: Date.now() },
        ...(choice.driverKind === null
          ? {}
          : { sessions: { defaultDriverKind: choice.driverKind } }),
      })
    } catch (error) {
      log.warn('onboarding completion could not be saved', error)
      return err({
        stage: 'settings',
        message:
          'Your setup is kept, but completion could not be saved. Retry, or leave setup for now without marking it complete.',
        failedPaths: [],
      })
    }
    completed = { sessionId, driverKind: choice.driverKind }
    return ok(completed)
  }

  return (choice, signal) => {
    if (signal.aborted) return Promise.resolve(cancelled())
    if (completed) return Promise.resolve(ok(completed))
    pending ??= finish(choice, signal).finally(() => {
      pending = null
    })
    return pending
  }
}

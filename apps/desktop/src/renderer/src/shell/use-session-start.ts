import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { useToast, type ToastOptions } from '@ari/ui/toast'
import { rpc } from '../lib/rpc'
import type { SessionDefaults } from '../App'
import type { SessionStartIntent } from './session-start-focus'

const log = createLogger('session-start')
type Stage = 'folder' | 'project' | 'create' | 'reuse'
interface Attempt {
  effective: SessionDefaults
  allowReuse: boolean
  projectId?: string
  path?: string
  reusableId?: string
  intent: SessionStartIntent
}
interface Recovery {
  attempt: Attempt
  stage: Stage
  error: string
  checked: boolean
}

/** One pending start, with stage-specific recovery and frozen user choices. */
export function useSessionStart(options: {
  defaults: SessionDefaults
  sessions: SessionSummary[]
  captureIntent: () => SessionStartIntent
  onStarted: (id: string, defaults: SessionDefaults | null, intent: SessionStartIntent) => void
  refreshProjects: () => void
  refreshSessions: () => void
  checkSessions: () => Promise<void>
}) {
  const latest = useRef(options)
  latest.current = options
  const { toast, update, dismiss } = useToast()
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const recoveryRef = useRef<Recovery | null>(null)
  const toastId = useRef<number | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const feedback = (value: ToastOptions): void => {
    if (!mounted.current) return
    const sticky = { ...value, durationMs: 0, dismissOnAction: false }
    if (toastId.current === null || !update(toastId.current, sticky))
      toastId.current = toast(sticky)
  }
  const busy = (value: boolean): void => {
    pendingRef.current = value
    if (mounted.current) setPending(value)
  }
  const clearRecovery = (): void => {
    recoveryRef.current = null
    if (toastId.current !== null) dismiss(toastId.current)
    toastId.current = null
  }
  const showRecovery = (recovery: Recovery): void => {
    const retry = (): void => {
      if (pendingRef.current || recoveryRef.current !== recovery) return
      clearRecovery()
      void run({ ...recovery.attempt, intent: latest.current.captureIntent() })
    }
    if (recovery.stage === 'create') {
      feedback({
        tone: 'warning',
        title: 'Couldn’t confirm the new session',
        description: recovery.checked
          ? 'The session list is refreshed. The earlier request may still have created a session. Open it from the sidebar, or explicitly start another.'
          : `${recovery.error} The request may have created a session. Check the session list before starting another.`,
        action: recovery.checked
          ? { label: 'Start another session', onClick: retry }
          : {
              label: 'Check sessions',
              onClick: () => {
                void check(recovery)
              },
            },
      })
    } else {
      feedback({
        tone: 'danger',
        title:
          recovery.stage === 'folder'
            ? 'Couldn’t choose a project folder'
            : recovery.stage === 'project'
              ? 'Couldn’t open the project'
              : 'Couldn’t prepare the session',
        description: `${recovery.attempt.path ? `${recovery.attempt.path}: ` : ''}${recovery.error}`,
        action: {
          label:
            recovery.stage === 'folder'
              ? 'Choose folder again'
              : recovery.stage === 'project'
                ? 'Retry opening project'
                : 'Retry session setup',
          onClick: retry,
        },
      })
    }
  }
  const check = async (recovery: Recovery): Promise<void> => {
    if (pendingRef.current || recoveryRef.current !== recovery) return
    busy(true)
    feedback({ title: 'Checking sessions…', tone: 'info', action: undefined })
    try {
      await latest.current.checkSessions()
      recovery.checked = true
      showRecovery(recovery)
    } catch (error) {
      feedback({
        title: 'Couldn’t refresh sessions',
        tone: 'danger',
        description: `${error instanceof Error ? error.message : String(error)} The earlier start is still unconfirmed.`,
        action: {
          label: 'Check sessions',
          onClick: () => {
            void check(recovery)
          },
        },
      })
    } finally {
      busy(false)
    }
  }
  const run = async (attempt: Attempt): Promise<void> => {
    if (pendingRef.current) {
      attempt.intent.dispose()
      return
    }
    busy(true)
    let stage: Stage = attempt.projectId ? 'create' : attempt.path ? 'project' : 'folder'
    try {
      if (!attempt.projectId) {
        if (!attempt.path) {
          const { path } = await rpc.invoke('dialog.pickFolder', { defaultPath: undefined })
          if (path === null) {
            attempt.intent.dispose()
            return
          }
          attempt.path = path
        }
        if (!attempt.intent.isCurrent() || !mounted.current) {
          attempt.intent.dispose()
          return
        }
        stage = 'project'
        const project = await rpc.invoke('project.open', { path: attempt.path })
        attempt.projectId = project.id
        latest.current.refreshProjects()
      }
      if (!attempt.intent.isCurrent() || !mounted.current) {
        attempt.intent.dispose()
        return
      }
      const reusable =
        attempt.reusableId ??
        (attempt.allowReuse && !attempt.effective.lead
          ? latest.current.sessions.find(
              (session) => session.projectId === attempt.projectId && session.messageCount === 0,
            )?.id
          : undefined)
      let sessionId: string
      let reseeded = false
      if (reusable) {
        reseeded = attempt.reusableId !== undefined || reusable !== attempt.intent.scope.sessionId
        attempt.reusableId = reusable
        stage = 'reuse'
        if (reseeded) {
          const result = await rpc.invoke('command.dispatch', {
            command: {
              type: 'session.update',
              sessionId: reusable,
              driverKind: attempt.effective.driverKind,
              modelId: attempt.effective.modelId,
              permissionMode: attempt.effective.permissionMode,
              effort: attempt.effective.effort,
            },
          })
          if (!result.accepted) throw new Error(result.reason ?? 'The session setup was refused.')
        }
        sessionId = reusable
      } else {
        stage = 'create'
        const result = await rpc.invoke('session.create', {
          projectId: attempt.projectId,
          title: 'New session',
          driverKind: attempt.effective.driverKind,
          modelId: attempt.effective.modelId,
          permissionMode: attempt.effective.permissionMode,
          effort: attempt.effective.effort,
          ...(attempt.effective.lead ? { lead: true } : {}),
        })
        if (typeof result?.sessionId !== 'string' || result.sessionId.length === 0)
          throw new Error('Session creation acknowledgement unavailable.')
        sessionId = result.sessionId
      }
      if (!mounted.current) {
        attempt.intent.dispose()
        return
      }
      clearRecovery()
      latest.current.onStarted(
        sessionId,
        reusable && !reseeded ? null : attempt.effective,
        attempt.intent,
      )
      latest.current.refreshSessions()
    } catch (error) {
      attempt.intent.dispose()
      log.warn(`${stage} start failed`, error)
      const recovery = {
        attempt,
        stage,
        error: error instanceof Error ? error.message : String(error),
        checked: false,
      }
      recoveryRef.current = recovery
      showRecovery(recovery)
    } finally {
      busy(false)
    }
  }

  // Toast actions outlive renders; always use the current shell callbacks.
  const actions = useRef({ run, showRecovery, clearRecovery })
  actions.current = { run, showRecovery, clearRecovery }
  const canStart = useCallback((): boolean => {
    if (pendingRef.current) return false
    const recovery = recoveryRef.current
    if (recovery?.stage === 'create') {
      actions.current.showRecovery(recovery)
      return false
    }
    return true
  }, [])
  const start = useCallback(
    (
      projectId: string | undefined,
      overrides?: Partial<SessionDefaults>,
      intent?: SessionStartIntent,
    ): void => {
      if (!canStart()) {
        intent?.dispose()
        return
      }
      actions.current.clearRecovery()
      void actions.current.run({
        projectId,
        effective: { ...latest.current.defaults, ...overrides },
        allowReuse: overrides?.driverKind === undefined,
        intent: intent ?? latest.current.captureIntent(),
      })
    },
    [canStart],
  )
  return {
    pending,
    canStart,
    create: useCallback(
      (projectId: string, overrides?: Partial<SessionDefaults>) => start(projectId, overrides),
      [start],
    ),
    pickProject: useCallback(
      (overrides?: Partial<SessionDefaults>, intent?: SessionStartIntent) =>
        start(undefined, overrides, intent),
      [start],
    ),
  }
}

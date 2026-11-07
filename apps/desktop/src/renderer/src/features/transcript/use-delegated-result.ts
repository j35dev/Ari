import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  OrchestrationDiff,
  OrchestrationMethod,
  OrchestrationParams,
  OrchestrationResults,
  OrchestrationTask,
  ResultPackage,
} from '@ari/contracts/orchestration'
import { rpc } from '../../lib/rpc'

type Target = Pick<ResultPackage, 'resultId' | 'attemptId' | 'snapshotCommit' | 'version'>
const targetOf = ({ resultId, attemptId, snapshotCommit, version }: ResultPackage): Target => ({
  resultId,
  attemptId,
  snapshotCommit,
  version,
})
const sameTarget = (result: ResultPackage, target: Target) =>
  result.resultId === target.resultId &&
  result.attemptId === target.attemptId &&
  result.version === target.version &&
  result.snapshotCommit === target.snapshotCommit

class ResultActionFailure extends Error {}

/** Nothing is fetched/subscribed until opened. Selection and receipts survive collapse. */
export function useDelegatedResult(sessionId: string, childSessionId: string, open: boolean) {
  const [task, setTask] = useState<OrchestrationTask | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [diff, setDiff] = useState<OrchestrationDiff | null>(null)
  const [retry, setRetry] = useState<{ label: string; action: () => Promise<void> } | null>(null)
  const keys = useRef(new Map<string, string>())
  const lock = useRef(false)
  const alive = useRef(true)
  const request = useRef(0)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      request.current++
    }
  }, [])

  const refresh = useCallback(async () => {
    const sequence = ++request.current
    setLoading(true)
    setLoadError(null)
    try {
      const view = await rpc.invoke('orchestration.view', { sessionId })
      if (!alive.current || sequence !== request.current) return
      const next =
        view.tasks.find((entry) =>
          entry.attempts.some((attempt) => attempt.sessionId === childSessionId),
        ) ?? null
      setTask(next)
      setTarget((previous) => {
        // Never follow a newer version implicitly, including after our own action.
        if (previous || !next) return previous
        const attempts = new Set(
          next.attempts.filter((a) => a.sessionId === childSessionId).map((a) => a.attemptId),
        )
        const results = next.results.filter((entry) => attempts.has(entry.attemptId))
        const initial =
          results.find((entry) => entry.resultId === next.currentResultId) ?? results.at(-1)
        return initial ? targetOf(initial) : null
      })
    } catch (cause) {
      if (alive.current && sequence === request.current)
        setLoadError(cause instanceof Error ? cause.message : 'Could not load this result.')
    } finally {
      if (alive.current && sequence === request.current) setLoading(false)
    }
  }, [sessionId, childSessionId])
  useEffect(() => {
    if (!open) return
    void refresh()
    return rpc.subscribe('orchestration.changed', { sessionId }, () => {
      void refresh()
    })
  }, [open, refresh, sessionId])

  const result = task?.results.find((entry) => target && sameTarget(entry, target)) ?? null
  const current =
    !!result &&
    result.resultId === task?.currentResultId &&
    result.attemptId === task.currentAttemptId
  const currentResult = task?.results.find((entry) => entry.resultId === task.currentResultId)

  const invoke = <M extends OrchestrationMethod>(
    method: M,
    params: OrchestrationParams<M>,
  ): Promise<OrchestrationResults[M]> => rpc.invoke(method, params)
  const receipt = (value: unknown) => {
    const fingerprint = JSON.stringify([sessionId, task?.taskId, value])
    let key = keys.current.get(fingerprint)
    if (!key) {
      key = `result_${crypto.randomUUID()}`
      keys.current.set(fingerprint, key)
    }
    return key
  }
  const update = (updated: ResultPackage) => {
    if (!alive.current) return
    setTask((previous) =>
      previous
        ? {
            ...previous,
            results: previous.results.map((entry) =>
              entry.resultId === updated.resultId ? updated : entry,
            ),
          }
        : previous,
    )
  }
  const run = async (label: string, action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    setRetry(null)
    try {
      await action()
    } catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : 'Could not complete this action.')
        // An explicit retry replays the SAME captured arguments/key, even if an
        // uncertain response was followed by a new current result.
        const stale =
          cause instanceof Error &&
          'code' in cause &&
          ['stale_result', 'stale_snapshot'].includes(String(cause.code))
        if (!(cause instanceof ResultActionFailure) && !stale) setRetry({ label, action })
      }
    } finally {
      lock.current = false
      if (alive.current) {
        setBusy(false)
        void refresh()
      }
    }
  }
  const select = (id: string) => {
    const selected = task?.results.find((entry) => entry.resultId === id)
    if (!selected || lock.current) return
    setTarget(targetOf(selected))
    setDiff(null)
    setError(null)
    setNotice(null)
    setRetry(null)
  }
  const reviewDiff = () => {
    if (!task || !result?.snapshotCommit || lock.current) return
    setDiff(null)
    const pinned = targetOf(result)
    void run(`review changes for version ${pinned.version}`, async () => {
      const next = await invoke('orchestration.diff', {
        sessionId,
        taskId: task.taskId,
        resultId: pinned.resultId,
        patch: true,
      })
      if (next.currentSnapshotCommit !== pinned.snapshotCommit)
        throw new ResultActionFailure(
          'This snapshot changed. Refresh and choose a result to review.',
        )
      if (alive.current) setDiff(next)
    })
  }
  const accept = () => {
    if (!task || !result || !current || result.snapshotUnavailable) return
    const params = {
      sessionId,
      taskId: task.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
      state: 'accepted' as const,
      idempotencyKey: receipt(['accept', target, result.reviewState, result.reviewHistory.length]),
    }
    void run(`accept version ${result.version}`, async () => {
      update(await invoke('orchestration.review', params))
      if (alive.current)
        setNotice(
          `Version ${result.version} ${result.snapshotCommit ? 'accepted.' : 'report accepted. No code was integrated.'}`,
        )
    })
  }
  const integrate = () => {
    if (!task || !result?.snapshotCommit || !current || result.reviewState !== 'accepted') return
    const fingerprint = ['integrate', target]
    const params = {
      sessionId,
      taskId: task.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
      idempotencyKey: receipt(fingerprint),
    }
    void run(`integrate version ${result.version}`, async () => {
      const response = await invoke('orchestration.integrate', params)
      if (response.status === 'conflict') {
        // Conflict is a definitive, completed outcome. A later integration
        // after resolving conflicts is a new action, not a lost-outcome replay.
        keys.current.delete(JSON.stringify([sessionId, task.taskId, fingerprint]))
        throw new ResultActionFailure(
          `Integration conflicts: ${response.files?.join(', ') || 'refresh changes for details'}`,
        )
      }
      update({ ...result, reviewState: 'integrated' })
      if (alive.current) setNotice(`Version ${result.version} integrated into the project.`)
    })
  }
  const verify = () => {
    if (!task || !result?.snapshotCommit || !current) return
    const params = {
      sessionId,
      taskId: task.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
      idempotencyKey: receipt(['verify', target]),
    }
    void run(`check whitespace for version ${result.version}`, async () => {
      const checked = await invoke('orchestration.verify', params)
      update(checked)
      const check = checked.verifiedChecks.at(-1)
      if (check?.exitCode !== 0)
        throw new ResultActionFailure(check?.detail || 'Snapshot whitespace check did not pass.')
      if (alive.current) setNotice('Snapshot whitespace check passed. Tests were not run.')
    })
  }
  const correct = (feedback: string, onStarted: () => void) => {
    if (!task || !result || !current || !feedback.trim()) return
    const text = feedback.trim()
    const review = {
      sessionId,
      taskId: task.taskId,
      resultId: result.resultId,
      snapshotCommit: result.snapshotCommit,
      state: 'changes_requested' as const,
      feedback: text,
      idempotencyKey: receipt(['feedback', target, text]),
    }
    const correction = {
      sessionId,
      taskId: task.taskId,
      feedback: text,
      newSession: false,
      expectedResultId: result.resultId,
      expectedAttemptId: result.attemptId,
      expectedSnapshotCommit: result.snapshotCommit,
      idempotencyKey: receipt(['correction', target, text]),
    }
    void run(`correction for version ${result.version}`, async () => {
      update(await invoke('orchestration.review', review))
      if (alive.current) setNotice('Feedback saved. Correction has not started yet.')
      await invoke('orchestration.retry', correction)
      if (alive.current) {
        setNotice(`Correction requested for version ${result.version}.`)
        onStarted()
      }
    })
  }
  return {
    task,
    result,
    target,
    current,
    currentResult,
    loading,
    loadError,
    busy,
    error,
    notice,
    diff,
    retry: retry
      ? {
          label: retry.label,
          run: () => {
            void run(retry.label, retry.action)
          },
        }
      : null,
    refresh,
    select,
    reviewDiff,
    accept,
    integrate,
    verify,
    correct,
  }
}

import { useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ContextPackage, OrchestrationTask } from '@ari/contracts/orchestration'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { agentModelLabel } from '../transcript/agent-label'
import { formatTokens, formatUsd } from '../usage/parse-ccusage'
import { workLabel } from './work-presentation'
import { invokeWork, workActionKey, workButton, workInput } from './work-actions'
import { WorkDecision } from './WorkDecision'
import { WorkContext } from './WorkContext'
import { WorkResult } from './WorkResult'
import { WorkMessages } from './WorkMessages'

export function WorkTaskDetails({
  sessionId,
  task,
  tasks,
  onChanged,
  onOpen,
}: {
  sessionId: string
  task: OrchestrationTask
  tasks: readonly OrchestrationTask[]
  onChanged: () => void
  onOpen?: (id: string) => void
}) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [recordedContext, setRecordedContext] = useState<ContextPackage | null>(null)
  const [transfer, setTransfer] = useState(false)
  const [provider, setProvider] = useState(task.driverKind)
  const [modelId, setModelId] = useState(task.modelId)
  const [catalog, setCatalog] = useState<RpcResults['providers.models']>([])
  const [context, setContext] = useState<ContextPackage | null>(null)
  const [editing, setEditing] = useState(false)
  const [goal, setGoal] = useState(task.assignment?.goal ?? '')
  const [dependsOn, setDependsOn] = useState(task.assignment?.dependsOn ?? [])
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null)
  const key = (payload: unknown) => {
    const fingerprint = JSON.stringify(payload)
    if (receipt.current?.fingerprint !== fingerprint)
      receipt.current = { fingerprint, key: workActionKey() }
    return receipt.current.key
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete the action.')
    } finally {
      setBusy(false)
    }
  }
  const attempt = task.attempts.find((item) => item.attemptId === task.currentAttemptId)
  const canRetry =
    !task.native &&
    (task.currentActivity.phase === 'ended' ||
      (attempt?.submission === 'pending' && task.currentActivity.waitReason === 'lead_decision'))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <p className="text-xs text-fg-muted">{workLabel(task)}</p>
        {task.currentActivity.detail ? (
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {task.currentActivity.detail}
          </p>
        ) : null}
        <p className="mt-1 text-2xs text-fg-subtle">
          {agentModelLabel(task.driverKind, task.modelId)} ·{' '}
          {task.workspaceMode === 'isolated' ? 'Isolated worktree' : 'Shared workspace'}
        </p>
        {task.child?.branch ? (
          <p className="mt-2 break-all font-mono text-2xs text-fg-subtle">{task.child.branch}</p>
        ) : null}
        <p className="mt-2 text-2xs text-fg-subtle">
          {task.currentActivity.freshness === 'live'
            ? 'Live connection'
            : task.currentActivity.freshness === 'journal'
              ? 'Journal state · Provider continuity unconfirmed'
              : 'Activity unavailable'}
          {task.currentActivity.observedAt
            ? ` · Last observed ${new Date(task.currentActivity.observedAt).toLocaleTimeString()}`
            : ''}
        </p>
        <div className="mt-3 flex flex-wrap gap-1">
          {onOpen && attempt?.sessionId ? (
            <button type="button" onClick={() => onOpen(attempt.sessionId!)} className={workButton}>
              Open conversation
            </button>
          ) : null}
          {task.currentActivity.phase !== 'ended' ? (
            <button
              type="button"
              disabled={busy || !task.capabilities.stop}
              title={
                !task.capabilities.stop
                  ? (task.capabilities.unavailableReason ?? 'Stopping is unavailable')
                  : undefined
              }
              onClick={() =>
                void run(async () => {
                  await invokeWork('orchestration.stop', {
                    sessionId,
                    taskId: task.taskId,
                    tree: false,
                    idempotencyKey: key(['stop', task.currentAttemptId]),
                  })
                })
              }
              className={workButton}
            >
              Stop task
            </button>
          ) : null}
          {canRetry ? (
            <button
              type="button"
              disabled={busy}
              className={workButton}
              onClick={() =>
                void run(async () => {
                  await invokeWork('orchestration.retry', {
                    sessionId,
                    taskId: task.taskId,
                    newSession: false,
                    idempotencyKey: key(['retry', task.currentAttemptId]),
                  })
                })
              }
            >
              Retry task
            </button>
          ) : null}
          {!task.native && task.currentActivity.phase === 'unknown' ? (
            <button
              type="button"
              disabled={busy}
              className={workButton}
              onClick={() =>
                void run(async () => {
                  await invokeWork('orchestration.retry', {
                    sessionId,
                    taskId: task.taskId,
                    newSession: true,
                    idempotencyKey: key(['recover', task.currentAttemptId]),
                  })
                })
              }
            >
              Recover in new session
            </button>
          ) : null}
          {!task.native ? (
            <button
              type="button"
              disabled={busy}
              className={workButton}
              onClick={() => {
                setTransfer((value) => !value)
                void rpc
                  .invoke('providers.models')
                  .then(setCatalog)
                  .catch(() => setError('The model catalog is unavailable.'))
              }}
            >
              Fork or change provider
            </button>
          ) : null}
        </div>
        {task.capabilities.unavailableReason ? (
          <p className="mt-2 text-2xs text-fg-subtle">{task.capabilities.unavailableReason}</p>
        ) : null}
      </div>
      {task.assignment ? (
        <section className="border-b border-border px-4 py-3" aria-label="Task assignment">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-fg">Assignment</h3>
            <button
              type="button"
              className={workButton}
              onClick={() => setEditing((value) => !value)}
            >
              Edit assignment
            </button>
          </div>
          {editing ? (
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  const assignment = { ...task.assignment!, goal: goal.trim(), dependsOn }
                  await invokeWork('orchestration.update', {
                    sessionId,
                    taskId: task.taskId,
                    assignment,
                    idempotencyKey: key(['assignment', assignment]),
                  })
                  setEditing(false)
                })
              }}
            >
              <label className="block text-xs text-fg-muted">
                Goal
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  required
                  rows={3}
                  className={`${workInput} mt-1`}
                />
              </label>
              <fieldset>
                <legend className="text-xs text-fg-muted">Prerequisites</legend>
                {tasks
                  .filter((item) => item.taskId !== task.taskId)
                  .map((item) => (
                    <label key={item.taskId} className="flex gap-2 py-1 text-2xs text-fg-muted">
                      <input
                        type="checkbox"
                        checked={dependsOn.includes(item.taskId)}
                        onChange={() =>
                          setDependsOn((list) =>
                            list.includes(item.taskId)
                              ? list.filter((id) => id !== item.taskId)
                              : [...list, item.taskId],
                          )
                        }
                      />
                      {item.title}
                    </label>
                  ))}
              </fieldset>
              <button type="submit" disabled={busy || !goal.trim()} className={workButton}>
                Save assignment
              </button>
            </form>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
                {task.assignment.goal}
              </p>
              {task.assignment.acceptanceCriteria.length ? (
                <ul className="mt-2 list-disc pl-4 text-2xs text-fg-muted">
                  {task.assignment.acceptanceCriteria.map((criterion, index) => (
                    <li key={index}>{criterion}</li>
                  ))}
                </ul>
              ) : null}
              {task.assignment.ownedPaths.length ? (
                <p className="mt-2 break-all font-mono text-2xs text-fg-subtle">
                  Owns {task.assignment.ownedPaths.join(', ')}
                </p>
              ) : null}
              {task.assignment.dependsOn.length ? (
                <p className="mt-2 text-2xs text-fg-subtle">
                  Prerequisites:{' '}
                  {task.assignment.dependsOn
                    .map(
                      (id) => tasks.find((item) => item.taskId === id)?.title ?? 'Unavailable task',
                    )
                    .join(', ')}
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {task.requests.map((request) => (
        <WorkDecision
          key={`${request.kind}:${request.requestId}`}
          sessionId={sessionId}
          request={request}
          onChanged={onChanged}
        />
      ))}
      {task.child?.latestTurn?.errorMessage ? (
        <p className="px-4 py-3 text-xs text-danger">{task.child.latestTurn.errorMessage}</p>
      ) : null}
      <WorkResult sessionId={sessionId} task={task} onChanged={onChanged} />
      {transfer ? (
        <form
          aria-label="Context handoff"
          className="space-y-3 border-b border-border px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!context) return
            void run(async () => {
              const payload = {
                sessionId,
                taskId: task.taskId,
                newSession: true,
                driverKind: provider,
                modelId,
                contextId: context.contextId,
              }
              await invokeWork('orchestration.retry', {
                ...payload,
                idempotencyKey: key(['handoff', payload]),
              })
              setTransfer(false)
            })
          }}
        >
          <h3 className="text-xs font-medium text-fg">Portable context handoff</h3>
          <p className="text-2xs text-fg-muted">
            Starts a new attempt in a new conversation. Select and preview its context first.
          </p>
          <label className="block text-xs text-fg-muted">
            Provider
            <select
              className={`${workInput} mt-1`}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as DriverKind)
                setModelId(null)
              }}
            >
              <option value={task.driverKind}>{task.driverKind}</option>
              {catalog
                .filter((row) => row.kind !== task.driverKind)
                .map((row) => (
                  <option key={row.kind} value={row.kind}>
                    {row.kind}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-xs text-fg-muted">
            Model
            <select
              className={`${workInput} mt-1`}
              value={modelId ?? ''}
              onChange={(event) => setModelId(event.target.value || null)}
            >
              <option value="">Provider default</option>
              {catalog
                .find((row) => row.kind === provider)
                ?.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
            </select>
          </label>
          <WorkContext
            key={provider}
            sessionId={sessionId}
            tasks={tasks}
            purpose={provider === task.driverKind ? 'fork' : 'handoff'}
            onPrepared={setContext}
          />
          <button
            type="submit"
            disabled={
              busy ||
              !context ||
              context.purpose !== (provider === task.driverKind ? 'fork' : 'handoff')
            }
            className={workButton}
          >
            Start new attempt with context
          </button>
        </form>
      ) : null}
      {!task.native ? (
        <form
          className="border-b border-border px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault()
            const redirect = feedback.trim()
            if (redirect)
              void run(async () => {
                if (canRetry || task.currentActivity.phase === 'unknown') {
                  await invokeWork('orchestration.retry', {
                    sessionId,
                    taskId: task.taskId,
                    feedback: redirect,
                    newSession: task.currentActivity.phase === 'unknown',
                    idempotencyKey: key(['follow-up', task.currentAttemptId, redirect]),
                  })
                  setNotice('Follow-up attempt submitted.')
                } else {
                  await invokeWork('orchestration.update', {
                    sessionId,
                    taskId: task.taskId,
                    redirect,
                    idempotencyKey: key(['redirect', task.currentAttemptId, redirect]),
                  })
                  setNotice('Note added to the agent inbox. Check Messages for its delivery state.')
                }
                setFeedback('')
              })
          }}
        >
          <label
            className="mb-2 block text-xs text-fg-muted"
            htmlFor={`work-feedback-${task.taskId}`}
          >
            Follow-up for this agent
          </label>
          <textarea
            id={`work-feedback-${task.taskId}`}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={3}
            maxLength={64000}
            className={workInput}
            placeholder="Clarify the task or redirect the work…"
          />
          <button
            type="submit"
            disabled={busy || !feedback.trim() || !task.capabilities.message}
            className={`${workButton} mt-2`}
          >
            {busy
              ? 'Sending…'
              : canRetry || task.currentActivity.phase === 'unknown'
                ? 'Start follow-up attempt'
                : 'Send coordination note'}
          </button>
        </form>
      ) : null}
      {!task.native ? (
        <details
          className="border-b border-border px-4 py-3 text-2xs text-fg-subtle"
          onToggle={(event) => setMessagesOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer">Coordination messages</summary>
          {messagesOpen ? (
            <WorkMessages
              sessionId={sessionId}
              taskId={task.taskId}
              observedAt={task.currentActivity.observedAt ?? 0}
            />
          ) : null}
        </details>
      ) : null}
      {task.attempts.length ? (
        <details className="px-4 py-3 text-2xs text-fg-subtle">
          <summary className="cursor-pointer">Attempt history ({task.attempts.length})</summary>
          <ul className="mt-2 space-y-2">
            {task.attempts.map((item, index) => (
              <li key={item.attemptId}>
                Attempt {index + 1} · {item.submission}
                {item.contextId ? ' · Context package recorded' : ''}
                {item.contextId ? (
                  <button
                    type="button"
                    disabled={busy}
                    className={`${workButton} ml-1`}
                    onClick={() =>
                      void run(async () => {
                        setRecordedContext(
                          await invokeWork('orchestration.context.get', {
                            sessionId,
                            contextId: item.contextId!,
                          }),
                        )
                      })
                    }
                  >
                    Inspect received context
                  </button>
                ) : null}
                {item.prerequisites?.length ? (
                  <ul className="mt-1 space-y-1 pl-2">
                    {item.prerequisites.map((prerequisite) => (
                      <li key={prerequisite.resultId}>
                        {tasks.find((task) => task.taskId === prerequisite.taskId)?.title ??
                          prerequisite.taskId}{' '}
                        · Version {prerequisite.version} ·{' '}
                        {prerequisite.snapshotCommit?.slice(0, 12) ?? 'Report only'}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {item.sessionId && onOpen ? (
                  <button
                    type="button"
                    className={`${workButton} ml-1`}
                    onClick={() => onOpen(item.sessionId!)}
                  >
                    Open
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {recordedContext ? (
        <section
          aria-label="Received context"
          className="border-b border-border px-4 py-3 text-2xs text-fg-muted"
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">Received context</h3>
            <button type="button" className={workButton} onClick={() => setRecordedContext(null)}>
              Close context
            </button>
          </div>
          <p>
            {recordedContext.chars.toLocaleString()} characters · {recordedContext.items.length}{' '}
            sources
          </p>
          <div className="mt-2 max-h-64 space-y-3 overflow-auto">
            {recordedContext.items.map((item, index) => (
              <div key={index}>
                <p className="break-words font-medium">
                  {item.kind} · {item.sourceId}
                  {item.truncated ? ' · Truncated' : ''}
                </p>
                <pre className="mt-1 whitespace-pre-wrap break-words">{item.content}</pre>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {task.child && task.child.usage.inputTokens + task.child.usage.outputTokens > 0 ? (
        <details className="px-4 py-3 text-2xs text-fg-subtle">
          <summary className="cursor-pointer">Attempt usage</summary>
          <p className="mt-2 font-mono tabular-nums">
            {formatTokens(task.child.usage.inputTokens + task.child.usage.outputTokens)} tokens
            {task.child.usage.costUsd === null
              ? ' · Pricing unavailable'
              : ` · ${formatUsd(task.child.usage.costUsd)}`}
          </p>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 py-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="px-4 py-3 text-xs text-success">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

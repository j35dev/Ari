import { useEffect, useRef, useState } from 'react'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { ContextPackage, OrchestrationTask } from '@ari/contracts/orchestration'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { WorkContext } from './WorkContext'
import { invokeWork, workActionKey, workButton, workInput } from './work-actions'

export function WorkLauncher({
  sessionId,
  tasks,
  defaults,
  onChanged,
  onCancel,
}: {
  sessionId: string
  tasks: readonly OrchestrationTask[]
  defaults: { driverKind: DriverKind; modelId: string | null; permissionMode: PermissionMode }
  onChanged: () => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [paths, setPaths] = useState('')
  const [criteria, setCriteria] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [role, setRole] = useState<
    'implementation' | 'research' | 'review' | 'design' | 'test' | 'general'
  >('implementation')
  const [workspaceMode, setWorkspaceMode] = useState<'isolated' | 'shared'>('isolated')
  const [provider, setProvider] = useState(defaults.driverKind)
  const [modelId, setModelId] = useState(defaults.modelId)
  const [compare, setCompare] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [catalog, setCatalog] = useState<RpcResults['providers.models']>([])
  const [context, setContext] = useState<ContextPackage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    titleInput.current?.focus()
    let cancelled = false
    void rpc
      .invoke('providers.models')
      .then((value) => {
        if (!cancelled) setCatalog(value)
      })
      .catch(() => {
        if (!cancelled)
          setError('The model catalog is unavailable. The session default can still be used.')
      })
    return () => {
      cancelled = true
    }
  }, [])
  const split = (text: string) =>
    text
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
  const ownedPaths = split(paths)
  const normalizePath = (path: string) =>
    path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
  const overlaps =
    workspaceMode === 'shared'
      ? tasks.filter(
          (task) =>
            task.workspaceMode === 'shared' &&
            !['ended'].includes(task.currentActivity.phase) &&
            task.assignment?.ownedPaths.some((existing) =>
              ownedPaths.some(
                (path) =>
                  normalizePath(path) === normalizePath(existing) ||
                  normalizePath(path).startsWith(`${normalizePath(existing)}/`) ||
                  normalizePath(existing).startsWith(`${normalizePath(path)}/`),
              ),
            ),
        )
      : []
  const selectedModels = catalog.find((row) => row.kind === provider)?.models ?? []
  return (
    <form
      className="space-y-3 px-4 py-4"
      aria-label="Add task"
      onSubmit={(event) => {
        event.preventDefault()
        if (
          busy ||
          !title.trim() ||
          !goal.trim() ||
          overlaps.length ||
          (compare && models.length < 2)
        )
          return
        const payload = {
          sessionId,
          title: title.trim(),
          assignment: {
            goal: goal.trim(),
            role,
            ownedPaths,
            acceptanceCriteria: split(criteria),
            dependsOn,
          },
          driverKind: provider,
          modelId,
          effort: null,
          permissionMode: defaults.permissionMode,
          workspaceMode: compare ? ('isolated' as const) : workspaceMode,
          ...(context ? { contextId: context.contextId } : {}),
        }
        const fingerprint = JSON.stringify({ payload, compare, models })
        const key =
          receipt.current?.fingerprint === fingerprint ? receipt.current.key : workActionKey()
        receipt.current = { fingerprint, key }
        setBusy(true)
        setError(null)
        const operation = compare
          ? invokeWork('orchestration.compare', {
              ...payload,
              idempotencyKey: key,
              models: models.map((id) => {
                const [driverKind, ...parts] = id.split(':')
                return { driverKind: driverKind as DriverKind, modelId: parts.join(':') || null }
              }),
            })
          : invokeWork('orchestration.launch', { ...payload, idempotencyKey: key })
        void operation
          .then(() => {
            onChanged()
            onCancel()
          })
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : 'Could not launch the task.'),
          )
          .finally(() => setBusy(false))
      }}
    >
      <h3 className="text-sm font-medium text-fg">Add a task</h3>
      <label className="block text-xs text-fg-muted">
        Task title
        <input
          ref={titleInput}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          required
          className={`${workInput} mt-1`}
          placeholder="Implement search API"
        />
      </label>
      <label className="block text-xs text-fg-muted">
        Assignment
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          maxLength={64000}
          rows={4}
          required
          className={`${workInput} mt-1`}
          placeholder="Describe the goal and expected output…"
        />
      </label>
      <label className="block text-xs text-fg-muted">
        Role
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as typeof role)}
          className={`${workInput} mt-1`}
        >
          {(['implementation', 'research', 'review', 'design', 'test', 'general'] as const).map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ),
          )}
        </select>
      </label>
      <label className="block text-xs text-fg-muted">
        Acceptance criteria, one per line
        <textarea
          value={criteria}
          onChange={(event) => setCriteria(event.target.value)}
          rows={2}
          className={`${workInput} mt-1`}
          placeholder="Search handles empty queries"
        />
      </label>
      <label className="block text-xs text-fg-muted">
        Owned paths, one per line
        <textarea
          value={paths}
          onChange={(event) => setPaths(event.target.value)}
          rows={2}
          className={`${workInput} mt-1 font-mono`}
          placeholder="src/search/"
        />
      </label>
      {tasks.length ? (
        <fieldset className="text-xs text-fg-muted">
          <legend className="mb-1">Prerequisites · Wait for accepted results</legend>
          <div className="max-h-32 overflow-y-auto">
            {tasks.map((task) => (
              <label key={task.taskId} className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={dependsOn.includes(task.taskId)}
                  onChange={() =>
                    setDependsOn((list) =>
                      list.includes(task.taskId)
                        ? list.filter((id) => id !== task.taskId)
                        : [...list, task.taskId],
                    )
                  }
                />
                {task.title}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={compare}
          onChange={(event) => setCompare(event.target.checked)}
        />
        Compare models on the same assignment
      </label>
      {compare ? (
        <fieldset className="text-xs text-fg-muted">
          <legend className="mb-1">Choose 2–8 models · Each uses an isolated workspace</legend>
          <div className="max-h-48 overflow-y-auto">
            {catalog.flatMap((row) =>
              row.models.map((model) => (
                <label key={`${row.kind}:${model.id}`} className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={models.includes(`${row.kind}:${model.id}`)}
                    disabled={models.length >= 8 && !models.includes(`${row.kind}:${model.id}`)}
                    onChange={() =>
                      setModels((list) =>
                        list.includes(`${row.kind}:${model.id}`)
                          ? list.filter((value) => value !== `${row.kind}:${model.id}`)
                          : [...list, `${row.kind}:${model.id}`],
                      )
                    }
                  />
                  {row.kind} · {model.label}
                </label>
              )),
            )}
          </div>
        </fieldset>
      ) : (
        <>
          <label className="block text-xs text-fg-muted">
            Provider
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as DriverKind)
                setModelId(null)
              }}
              className={`${workInput} mt-1`}
            >
              <option value={defaults.driverKind}>{defaults.driverKind} · Session default</option>
              {catalog
                .filter((row) => row.kind !== defaults.driverKind)
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
              value={modelId ?? ''}
              onChange={(event) => setModelId(event.target.value || null)}
              className={`${workInput} mt-1`}
            >
              <option value="">Provider default</option>
              {selectedModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-fg-muted">
            Workspace
            <select
              value={workspaceMode}
              onChange={(event) => setWorkspaceMode(event.target.value as typeof workspaceMode)}
              className={`${workInput} mt-1`}
            >
              <option value="isolated">Isolated worktree</option>
              <option value="shared">Shared project workspace</option>
            </select>
          </label>
        </>
      )}
      {overlaps.length ? (
        <p role="alert" className="text-xs text-warning">
          Owned paths overlap with {overlaps.map((task) => task.title).join(', ')}. Choose isolated
          worktrees or update ownership before launching.
        </p>
      ) : null}
      <WorkContext sessionId={sessionId} tasks={tasks} onPrepared={setContext} />
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            busy ||
            !title.trim() ||
            !goal.trim() ||
            !!overlaps.length ||
            (compare && models.length < 2)
          }
          className={`${workButton} bg-surface-2 text-fg`}
        >
          {busy ? 'Launching…' : compare ? 'Launch comparison' : 'Launch task'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={workButton}>
          Cancel
        </button>
      </div>
    </form>
  )
}

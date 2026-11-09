import type { AgentEvent } from '@ari/contracts/agent-event'
import type { BackgroundTaskKind, BackgroundTaskStatus } from '@ari/contracts/background-task'
import { MAX_BACKGROUND_TASKS } from '@ari/contracts/background-task'
import type { NativeLine } from './mapper'

type Json = Record<string, unknown>
type TaskEvent = Extract<AgentEvent, { type: 'background-task' }>
interface Task {
  id: string
  kind: BackgroundTaskKind
  label: string
  status: BackgroundTaskStatus
  detail: string | null
  background: boolean
  nativeId: string | null
  runId: string | null
  sent: string
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
function brief(value: string): string {
  return value.split(/\r?\n/, 1)[0]!.slice(0, 160)
}
function terminal(value: unknown): BackgroundTaskStatus | null {
  if (value === 'completed' || value === 'failed' || value === 'stopped') return value
  return value === 'killed' ? 'stopped' : null
}

/** Claude's tool calls and SDK task bookends describe the same native work. */
export class ClaudeBackgroundTasks {
  readonly #tasks = new Map<string, Task>()
  readonly #aliases = new Map<string, string>()
  readonly #stops = new Map<string, string>()
  #sessionId: string | null = null

  observe(line: NativeLine): AgentEvent[] {
    if (line.subtype === 'init') this.#sessionId = text(line.session_id)
    const events: AgentEvent[] = []
    if (line.type === 'result') {
      for (const task of this.#tasks.values()) {
        if (task.background || task.status !== 'running') continue
        task.status = line.is_error ? 'failed' : 'completed'
        events.push(...this.#emit(task))
      }
      return events
    }
    if (line.type === 'system' && line.subtype === 'background_tasks_changed') {
      if (!Array.isArray(line.tasks)) return []
      const live = new Set<Task>()
      for (const entry of line.tasks) {
        // Snapshots can precede task_started, which carries the tool-call
        // binding. Reconcile known rows without inventing a duplicate row.
        const task = this.#lifecycle(entry, false)
        if (!task) continue
        task.background = true
        live.add(task)
        events.push(...this.#emit(task))
      }
      for (const task of this.#tasks.values()) {
        if (!task.background || !task.nativeId || task.status !== 'running' || live.has(task))
          continue
        // The level signal gives no terminal outcome; a bookend can refine it.
        task.status = 'stopped'
        task.detail = 'No longer reported as running'
        events.push(...this.#emit(task))
      }
      return events
    }
    if (line.type === 'system' && line.subtype?.startsWith('task_')) {
      const task = this.#lifecycle(line)
      if (!task) return []
      if (line.subtype === 'task_notification') {
        const status = terminal(line.status)
        if (!status) return []
        task.status = status
        task.detail = text(line.summary) ?? task.detail
      } else if (line.subtype === 'task_progress') {
        task.detail =
          text(line.summary) ?? text(line.last_tool_name) ?? text(line.description) ?? task.detail
      } else if (line.subtype === 'task_updated') {
        task.status = terminal(line.patch?.['status']) ?? task.status
        task.background ||= line.patch?.['is_backgrounded'] === true
        task.detail = text(line.patch?.['error']) ?? task.detail
      }
      return this.#emit(task)
    }
    if (line.type === 'assistant') {
      for (const block of line.message?.content ?? []) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue
        const input = record(block.input)
        const parent = this.#find(line.parent_tool_use_id)
        if (parent?.status === 'running') {
          parent.detail = brief(
            text(input?.['description']) ?? text(input?.['file_path']) ?? block.name,
          )
          events.push(...this.#emit(parent))
        }
        if (block.name === 'Agent' || block.name === 'Task') {
          const task = this.#find(block.id) ?? this.#open(block.id, 'subagent')
          task.label = brief(
            text(input?.['description']) ?? text(input?.['subagent_type']) ?? task.label,
          )
          task.detail ??= text(input?.['subagent_type'])
          task.background ||= input?.['run_in_background'] === true
          events.push(...this.#emit(task))
        } else if (block.name === 'Bash' && input?.['run_in_background'] === true) {
          const task = this.#find(block.id) ?? this.#open(block.id, 'shell')
          task.background = true
          task.label = brief(text(input['description']) ?? text(input['command']) ?? task.label)
          events.push(...this.#emit(task))
        } else if (block.name === 'TaskStop' || block.name === 'KillShell') {
          const target = text(input?.['task_id']) ?? text(input?.['shell_id'])
          if (target) this.#stops.set(block.id, target)
        }
      }
    } else if (line.type === 'user') {
      for (const block of line.message?.content ?? []) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue
        const stopped = this.#stops.get(block.tool_use_id)
        this.#stops.delete(block.tool_use_id)
        const task = this.#find(stopped ?? block.tool_use_id)
        if (!task || task.status !== 'running') continue
        const response = record(line.tool_use_result)
        if (response?.['isAsync'] === true || response?.['status'] === 'async_launched') {
          task.background = true
          const id = text(response['agentId']) ?? text(response['backgroundTaskId'])
          if (id) this.#aliases.set(id, task.id)
        }
        if (stopped) {
          if (block.is_error) continue
          task.status = 'stopped'
          task.detail = 'Stopped by Claude'
        } else if (block.is_error) task.status = 'failed'
        else if (task.kind === 'subagent' && !task.background) task.status = 'completed'
        events.push(...this.#emit(task))
      }
    }
    return events
  }

  running(): TaskEvent[] {
    return [...this.#tasks.values()]
      .filter((task) => task.status === 'running')
      .map((task) => this.#event(task))
  }

  #find(id: string | null | undefined): Task | undefined {
    return id ? this.#tasks.get(this.#aliases.get(id) ?? id) : undefined
  }

  #open(id: string, kind: BackgroundTaskKind): Task {
    const task: Task = {
      id,
      kind,
      label: kind === 'subagent' ? 'Claude agent' : 'Shell command',
      status: 'running',
      detail: null,
      background: false,
      nativeId: null,
      runId: null,
      sent: '',
    }
    this.#tasks.set(id, task)
    for (const [oldId, old] of this.#tasks) {
      if (this.#tasks.size <= MAX_BACKGROUND_TASKS) break
      if (old.status === 'running') continue
      this.#tasks.delete(oldId)
      for (const [alias, target] of this.#aliases) if (target === oldId) this.#aliases.delete(alias)
    }
    return task
  }

  #lifecycle(line: NativeLine, open = true): Task | null {
    if (!text(line.task_id) || line.ambient || line.skip_transcript) return null
    let task = this.#find(line.tool_use_id) ?? this.#find(line.task_id)
    const runId = text(line.run_id)
    if (task?.runId && runId && runId < task.runId) return null
    if (!task) {
      if (!open) return null
      const kind =
        line.task_type === 'local_agent' || line.subagent_type
          ? 'subagent'
          : line.task_type === 'local_bash' && line.is_backgrounded !== false
            ? 'shell'
            : null
      if (!kind) return null
      task = this.#open(line.tool_use_id ?? line.task_id!, kind)
    }
    if (line.tool_use_id) this.#aliases.set(line.tool_use_id, task.id)
    task.nativeId = line.task_id!
    this.#aliases.set(line.task_id!, task.id)
    if (runId && runId !== task.runId) {
      task.runId = runId
      task.status = 'running'
      task.detail = null
    }
    if (line.subtype === 'task_started' || !line.subtype) task.status = 'running'
    task.background ||= line.is_backgrounded === true
    task.label = brief(text(line.description) ?? text(line.patch?.['description']) ?? task.label)
    return task
  }

  #event(task: Task): TaskEvent {
    return {
      type: 'background-task',
      id: task.id,
      kind: task.kind,
      label: task.label,
      status: task.status,
      detail: task.detail,
      ...(this.#sessionId ? { providerThreadId: this.#sessionId } : {}),
      providerItemId: task.id,
    }
  }
  #emit(task: Task): TaskEvent[] {
    const event = this.#event(task)
    const serialized = JSON.stringify(event)
    if (serialized === task.sent) return []
    task.sent = serialized
    return [event]
  }
}

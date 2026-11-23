import type { AgentEvent } from '@ari/contracts/agent-event'
import type {
  BackgroundTaskKind,
  BackgroundTaskStatus,
  SubagentDetails,
} from '@ari/contracts/background-task'
import { clipSubagentText, MAX_BACKGROUND_TASKS } from '@ari/contracts/background-task'
import type { NativeLine } from './mapper'

type Json = Record<string, unknown>
type TaskEvent = Extract<AgentEvent, { type: 'background-task' }>
const DETAIL_KEYS = ['subagentType', 'prompt', 'model', 'result'] as const
interface Task {
  id: string
  kind: BackgroundTaskKind
  label: string
  status: BackgroundTaskStatus
  detail: string | null
  background: boolean
  nativeId: string | null
  callId: string | null
  runId: string | null
  sent: string
  /** What a subagent was asked and answered; reported once each, when it changes. */
  details: Required<SubagentDetails>
  sentDetails: SubagentDetails
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
/** A tool result's text: a plain string, or the text blocks of a content list. */
function resultText(value: unknown): string | null {
  if (typeof value === 'string') return text(value)
  if (!Array.isArray(value)) return null
  const parts = value.flatMap((block) => {
    const entry = record(block)
    return entry?.['type'] === 'text' && typeof entry['text'] === 'string' ? [entry['text']] : []
  })
  return text(parts.join('\n\n'))
}
function terminal(value: unknown): BackgroundTaskStatus | null {
  if (value === 'completed' || value === 'failed' || value === 'stopped') return value
  return value === 'killed' ? 'stopped' : null
}

/** SDK tool calls and task bookends describe the same native work. */
export class ClaudeBackgroundTasks {
  readonly #tasks = new Map<string, Task>()
  readonly #aliases = new Map<string, string>()
  readonly #stops = new Map<string, string>()
  #sessionId: string | null = null
  constructor(
    private readonly provider = 'Claude',
    private readonly options: { nativeBookends?: boolean } = {},
  ) {}

  observe(line: NativeLine): AgentEvent[] {
    if (line.subtype === 'init') this.#sessionId = text(line.session_id)
    const events: AgentEvent[] = []
    if (line.type === 'tool_progress') {
      const task = this.#find(line.parent_tool_use_id) ?? this.#find(line.tool_use_id)
      if (!task || task.status !== 'running') return []
      task.detail = brief(
        `${line.tool_name ?? 'Working'}${typeof line.elapsed_time_seconds === 'number' ? ` (${Math.floor(line.elapsed_time_seconds)}s)` : ''}`,
      )
      return this.#emit(task)
    }
    if (line.type === 'result' && line.parent_tool_use_id == null) {
      if (this.options.nativeBookends) return []
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
        const summary = text(line.summary)
        if (task.kind === 'subagent' && summary) task.details.result = clipSubagentText(summary)
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
      const parent = this.#find(line.parent_tool_use_id)
      const model = text(line.message?.model)
      if (parent?.kind === 'subagent' && model && parent.details.model !== model) {
        parent.details.model = model
        events.push(...this.#emit(parent))
      }
      for (const block of line.message?.content ?? []) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue
        const input = record(block.input)
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
          task.details.subagentType = text(input?.['subagent_type']) ?? task.details.subagentType
          const prompt = text(input?.['prompt'])
          if (prompt) task.details.prompt = clipSubagentText(prompt)
          task.details.model ??= text(input?.['model'])
          events.push(...this.#emit(task))
        } else if (
          (block.name === 'Bash' || block.name === 'PowerShell') &&
          input?.['run_in_background'] === true
        ) {
          const task = this.#find(block.id) ?? this.#open(block.id, 'shell')
          task.background = true
          task.label = brief(text(input['description']) ?? text(input['command']) ?? task.label)
          events.push(...this.#emit(task))
        } else if (
          block.name === 'TaskStop' ||
          block.name === 'KillShell' ||
          block.name === 'KillBash'
        ) {
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
        if (
          response?.['isAsync'] === true ||
          response?.['status'] === 'async_launched' ||
          text(response?.['backgroundTaskId'])
        ) {
          task.background = true
          const id =
            text(response?.['agentId']) ??
            text(response?.['backgroundTaskId']) ??
            text(response?.['shellId'])
          if (id) this.#aliases.set(id, task.id)
          const resolved = text(response?.['resolvedModel'])
          if (task.kind === 'subagent' && resolved) task.details.model = resolved
        }
        if (stopped) {
          if (block.is_error) continue
          task.status = 'stopped'
          task.detail = `Stopped by ${this.provider}`
        } else if (block.is_error) task.status = 'failed'
        else if (
          task.kind === 'subagent' &&
          !task.background &&
          (!this.options.nativeBookends || !task.nativeId)
        ) {
          task.status = 'completed'
          const result = resultText(block.content)
          if (result) task.details.result = clipSubagentText(result)
        }
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

  /** The task a native agent or task id names, as its background task id. */
  taskIdOf(nativeId: string | null | undefined): string | null {
    return this.#find(nativeId)?.id ?? null
  }
  nativeIdOf(id: string): string | null {
    return this.#find(id)?.nativeId ?? null
  }

  /** Whether any subagent is still running. */
  hasRunningSubagents(): boolean {
    return [...this.#tasks.values()].some(
      (task) => task.kind === 'subagent' && task.status === 'running',
    )
  }

  interruptSubagents(): { nativeIds: string[]; events: AgentEvent[] } {
    const nativeIds: string[] = []
    const events: AgentEvent[] = []
    for (const task of this.#tasks.values()) {
      if (task.kind !== 'subagent' || task.status !== 'running') continue
      if (task.nativeId) nativeIds.push(task.nativeId)
      task.status = 'stopped'
      task.detail = 'Stopped with the turn'
      events.push(...this.#emit(task))
    }
    return { nativeIds, events }
  }

  #find(id: string | null | undefined): Task | undefined {
    return id ? this.#tasks.get(this.#aliases.get(id) ?? id) : undefined
  }

  #open(id: string, kind: BackgroundTaskKind): Task {
    const task: Task = {
      id,
      kind,
      label: kind === 'subagent' ? `${this.provider} agent` : 'Shell command',
      status: 'running',
      detail: null,
      background: false,
      nativeId: null,
      callId: null,
      runId: null,
      sent: '',
      details: { subagentType: null, prompt: null, model: null, result: null },
      sentDetails: {},
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
    const callTask = this.#find(line.tool_use_id)
    const nativeTask = this.#find(line.task_id)
    let task = nativeTask ?? callTask
    const runId = text(line.run_id)
    if (task?.runId && runId && runId < task.runId) return null
    // A native-only start and an independent streamed Agent call may both
    // precede their explicit binding. Keep the native row's identity and merge
    // the call's metadata only once the harness supplies that binding.
    if (nativeTask && callTask && nativeTask !== callTask) {
      task = nativeTask
      task.background ||= callTask.background
      for (const key of DETAIL_KEYS) task.details[key] ??= callTask.details[key]
      this.#tasks.delete(callTask.id)
      for (const [alias, target] of this.#aliases)
        if (target === callTask.id) this.#aliases.set(alias, task.id)
      this.#aliases.set(callTask.id, task.id)
    }
    if (!task) {
      if (!open) return null
      const kind =
        line.task_type === 'local_agent' || line.subagent_type
          ? 'subagent'
          : (line.task_type === 'local_bash' || line.task_type === 'local_powershell') &&
              line.is_backgrounded !== false
            ? 'shell'
            : null
      if (!kind) return null
      task = this.#open(line.tool_use_id ?? line.task_id!, kind)
    }
    if (line.tool_use_id) {
      this.#aliases.set(line.tool_use_id, task.id)
      task.callId = line.tool_use_id
    }
    task.nativeId = line.task_id!
    this.#aliases.set(line.task_id!, task.id)
    if (runId && runId !== task.runId) {
      task.runId = runId
      task.status = 'running'
      task.detail = null
    }
    if (line.subtype === 'task_started' || !line.subtype) task.status = 'running'
    task.background ||= line.is_backgrounded === true
    // A progress line's description is the current step, not what the task is.
    if (line.subtype !== 'task_progress')
      task.label = brief(text(line.description) ?? text(line.patch?.['description']) ?? task.label)
    if (task.kind === 'subagent') {
      task.details.subagentType = text(line.subagent_type) ?? task.details.subagentType
      // A resumed run may carry no prompt; it keeps the one it was first given.
      const prompt = text(line.prompt)
      if (line.subtype === 'task_started' && prompt) task.details.prompt = clipSubagentText(prompt)
    }
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
      providerItemId: task.callId ?? task.id,
      ...(task.nativeId ? { nativeTaskId: task.nativeId } : {}),
    }
  }
  /** Reports a change; subagent details ride along only when they changed. */
  #emit(task: Task): TaskEvent[] {
    const event = this.#event(task)
    const serialized = JSON.stringify(event)
    const changed: SubagentDetails = {}
    if (task.kind === 'subagent')
      for (const key of DETAIL_KEYS)
        if (task.details[key] !== null && task.details[key] !== task.sentDetails[key])
          changed[key] = task.details[key]
    if (serialized === task.sent && Object.keys(changed).length === 0) return []
    task.sent = serialized
    Object.assign(task.sentDetails, changed)
    return [{ ...event, ...changed }]
  }
}

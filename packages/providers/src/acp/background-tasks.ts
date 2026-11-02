import type { AgentEvent } from '@ari/contracts/agent-event'
import type { BackgroundTaskKind, BackgroundTaskStatus } from '@ari/contracts/background-task'
import type { AcpToolCallUpdate } from './protocol'

/**
 * Derives the sub-agents and background shells an agent's own harness runs
 * from the tool calls it reports, using only what adapters send to a client
 * with Ari's current capabilities (no `subagents`, no AIR `asyncTasks`, no
 * terminal output). The signals and the rules built on them:
 *
 * Sub-agents (Claude Code `Agent`/`Task`, named by `_meta.claudeCode.toolName`):
 * - open when the call is reported, labelled by its `description`;
 * - follow the latest tool call stamped `_meta.claudeCode.parentToolUseId`
 *   with the sub-agent's call id, as its activity line;
 * - end with their call's final update, unless the call ran asynchronously
 *   (`run_in_background` input, or a `toolResponse` of `async_launched`):
 *   then they run on until the prompt that started them returns, which the
 *   Claude adapter holds open while sub-agents of the turn are still live.
 * - A Codex collab `spawnAgent` opens one per receiver thread; the
 *   `agentsStates` that later collab calls carry end them, and so does the
 *   prompt returning, since Codex waits for its agents too.
 *
 * Background shells (Bash/PowerShell with `run_in_background`, or a result
 * naming a `backgroundTaskId`):
 * - the call itself completes at once, while the command runs on;
 * - nothing on the wire says when the command ends, so a shell ends only on
 *   evidence: the agent stopping it (TaskStop/KillShell naming its task id),
 *   or the agent reporting back between turns while that shell is the only
 *   work Ari knows to be running (see {@link betweenTurns}). Otherwise it
 *   stays running; the engine stops tracking it when the next turn starts or
 *   the agent process ends.
 */

type Json = Record<string, unknown>

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash'])
const LABEL_MAX = 80
/** Between-turn output this far apart counts as separate reports. */
const BURST_GAP_MS = 5_000

interface Tracked {
  id: string
  kind: BackgroundTaskKind
  label: string
  status: BackgroundTaskStatus
  detail: string | null
  /** Runs on after its call returns (an async sub-agent). */
  async: boolean
  /** The harness's own id for it (background task id, agent id), for stops. */
  harnessId: string | null
  /** Closed by the prompt ending; later reports about it are stale. */
  final: boolean
  /** Launch order, so a between-turn report can tell what came before it. */
  seq: number
  /** The child call its activity line shows, for a sub-agent. */
  activity: string | null
  /** What was last reported, so unchanged updates send nothing. */
  sent: string
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function clip(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? value
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line
}

export class BackgroundTaskTracker {
  readonly #tasks = new Map<string, Tracked>()
  /** Stop calls by call id, with the task id they name. */
  readonly #stops = new Map<string, string>()
  #seq = 0
  #burst: { seq: number; lastAt: number; attributed: boolean } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** Reads one `tool_call` / `tool_call_update` for background work. */
  observe(update: AcpToolCallUpdate): AgentEvent[] {
    const callId = text(update.toolCallId)
    if (callId === null) return []
    const meta = record(update._meta)
    const claude = record(meta?.['claudeCode'])
    const input = record(update.rawInput)
    const collab = record(record(meta?.['codex'])?.['collaboration'])
    if (collab !== null) return this.#codex(update, collab, input)

    const toolName = text(claude?.['toolName'])
    const response = record(claude?.['toolResponse'])
    const events: AgentEvent[] = []
    const parentId = text(claude?.['parentToolUseId'])
    const parent = parentId === null ? undefined : this.#tasks.get(parentId)
    if (parent?.kind === 'subagent' && parent.status === 'running' && !parent.final) {
      // A new child call becomes the activity line; the current one may
      // still sharpen it once its input has streamed in.
      const title = text(update.title)
      if (update.sessionUpdate === 'tool_call' || (parent.activity === callId && title !== null)) {
        parent.activity = callId
        parent.detail = clip(title ?? toolName ?? 'Working')
        events.push(...this.#emit(parent))
      }
    }
    const known = this.#tasks.get(callId)
    if (known?.final === true) return events
    if ((toolName !== null && SUBAGENT_TOOLS.has(toolName)) || known?.kind === 'subagent')
      events.push(...this.#subagent(callId, update, input, response))
    else if ((toolName !== null && SHELL_TOOLS.has(toolName)) || known?.kind === 'shell')
      events.push(...this.#shell(callId, update, input, response))
    else if ((toolName !== null && STOP_TOOLS.has(toolName)) || this.#stops.has(callId))
      events.push(...this.#stop(callId, update, input))
    return events
  }

  /**
   * The prompt returned. Sub-agents still open ended with it: the adapters
   * hold the prompt while a turn's sub-agents run, so what remains either
   * finished or was stopped with the turn. Shells run on.
   */
  endPrompt(stopReason: string): AgentEvent[] {
    this.#burst = null
    const events: AgentEvent[] = []
    for (const task of this.#tasks.values()) {
      if (task.kind !== 'subagent' || task.final) continue
      task.final = true
      if (task.status !== 'running') continue
      task.status = stopReason === 'cancelled' ? 'stopped' : 'completed'
      events.push(...this.#emit(task))
    }
    return events
  }

  /**
   * What the agent emitted between turns. A harness wakes its agent between
   * turns when background work it started finishes, so the first prose of a
   * report most likely answers for that work. Only when exactly one shell
   * launched before the report is running, and no sub-agent, is it taken as
   * the one that finished. With several, the report cannot be attributed and
   * every shell stays running.
   */
  betweenTurns(fold: () => AgentEvent[]): AgentEvent[] {
    // The report starts before its first update is folded, so a shell that
    // update launches does not count as running before it.
    const now = this.now()
    if (this.#burst === null || now - this.#burst.lastAt > BURST_GAP_MS)
      this.#burst = { seq: this.#seq, lastAt: now, attributed: false }
    this.#burst.lastAt = now
    const events = fold()
    if (this.#burst.attributed || !events.some((event) => event.type === 'text-delta'))
      return events
    this.#burst.attributed = true
    return [...events, ...this.#attribute(this.#burst.seq)]
  }

  /** Ends the one shell launched before the report, when it is the only work. */
  #attribute(before: number): AgentEvent[] {
    const running = [...this.#tasks.values()].filter((task) => task.status === 'running')
    if (running.some((task) => task.kind === 'subagent')) return []
    // Shells the report itself launched cannot be what it reports on.
    const earlier = running.filter((task) => task.seq <= before)
    const shell = earlier[0]
    if (earlier.length !== 1 || shell === undefined) return []
    shell.status = 'completed'
    shell.detail = 'The agent reported back'
    return this.#emit(shell)
  }

  /** A new turn starts; the engine ends what earlier turns left open. */
  beginTurn(): void {
    this.#tasks.clear()
    this.#stops.clear()
    this.#burst = null
  }

  #open(id: string, kind: BackgroundTaskKind, label: string, detail: string | null): Tracked {
    const task: Tracked = {
      id,
      kind,
      label,
      status: 'running',
      detail,
      async: false,
      harnessId: null,
      final: false,
      seq: ++this.#seq,
      activity: null,
      sent: '',
    }
    this.#tasks.set(id, task)
    return task
  }

  #subagent(
    callId: string,
    update: AcpToolCallUpdate,
    input: Json | null,
    response: Json | null,
  ): AgentEvent[] {
    const label = text(input?.['description']) ?? text(input?.['subagent_type'])
    const type = text(input?.['subagent_type']) ?? text(response?.['subagentType'])
    let task = this.#tasks.get(callId)
    if (task === undefined) task = this.#open(callId, 'subagent', 'Sub-agent', type)
    if (label !== null) task.label = clip(label)
    if (task.detail === null && type !== null) task.detail = type
    if (input?.['run_in_background'] === true) task.async = true
    const launchedAsync =
      response?.['status'] === 'async_launched' || response?.['isAsync'] === true
    if (launchedAsync) {
      task.async = true
      task.harnessId = text(response?.['agentId']) ?? task.harnessId
      // The marker can arrive after the call's completion closed it.
      if (task.status === 'completed') task.status = 'running'
    }
    if (update.status === 'failed') task.status = 'failed'
    else if (update.status === 'completed' && !task.async) task.status = 'completed'
    return this.#emit(task)
  }

  #shell(
    callId: string,
    update: AcpToolCallUpdate,
    input: Json | null,
    response: Json | null,
  ): AgentEvent[] {
    const backgroundId = text(response?.['backgroundTaskId'])
    let task = this.#tasks.get(callId)
    if (task === undefined) {
      if (input?.['run_in_background'] !== true && backgroundId === null) return []
      task = this.#open(callId, 'shell', 'Shell command', null)
    }
    const label = text(input?.['description']) ?? text(input?.['command'])
    if (label !== null) task.label = clip(label)
    if (backgroundId !== null) task.harnessId = backgroundId
    // The call completing only means the command was handed off; a failed
    // call means it never started.
    if (update.status === 'failed' && task.status === 'running') {
      task.status = 'failed'
      task.detail = 'Did not start'
    }
    return this.#emit(task)
  }

  #stop(callId: string, update: AcpToolCallUpdate, input: Json | null): AgentEvent[] {
    const target = text(input?.['task_id']) ?? text(input?.['shell_id']) ?? text(input?.['bash_id'])
    if (target !== null) this.#stops.set(callId, target)
    if (update.status === 'failed') this.#stops.delete(callId)
    if (update.status !== 'completed') return []
    const named = this.#stops.get(callId)
    this.#stops.delete(callId)
    if (named === undefined) return []
    for (const task of this.#tasks.values()) {
      if (task.status !== 'running' || (task.harnessId !== named && task.id !== named)) continue
      task.status = 'stopped'
      task.detail = 'Stopped by the agent'
      return this.#emit(task)
    }
    return []
  }

  #codex(update: AcpToolCallUpdate, collab: Json, input: Json | null): AgentEvent[] {
    const events: AgentEvent[] = []
    if (collab['tool'] === 'spawnAgent') {
      const threads = Array.isArray(input?.['receiverThreadIds'])
        ? (input['receiverThreadIds'] as unknown[])
        : []
      const label = text(input?.['prompt'])
      for (const raw of threads) {
        const threadId = text(raw)
        if (threadId === null) continue
        let task = this.#tasks.get(threadId)
        if (task === undefined) task = this.#open(threadId, 'subagent', 'Sub-agent', null)
        if (task.final) continue
        if (label !== null) task.label = clip(label)
        if (update.status === 'failed') task.status = 'failed'
        events.push(...this.#emit(task))
      }
    }
    const states = record(input?.['agentsStates'])
    for (const [threadId, raw] of Object.entries(states ?? {})) {
      const task = this.#tasks.get(threadId)
      if (task === undefined || task.final) continue
      const status = text(record(raw)?.['status'])
      if (status === 'completed') task.status = 'completed'
      else if (status === 'interrupted') task.status = 'stopped'
      else if (status === 'errored' || status === 'shutdown' || status === 'notFound')
        task.status = 'failed'
      else if (status === 'running' || status === 'pendingInit') task.status = 'running'
      events.push(...this.#emit(task))
    }
    return events
  }

  #emit(task: Tracked): AgentEvent[] {
    const sent = JSON.stringify([task.label, task.status, task.detail])
    if (sent === task.sent) return []
    task.sent = sent
    return [
      {
        type: 'background-task',
        id: task.id,
        kind: task.kind,
        label: task.label,
        status: task.status,
        detail: task.detail,
      },
    ]
  }
}

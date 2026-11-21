import type { AgentEvent, SubagentActivity } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'
import { imageOutputEvents } from '../image-output'
import { claudeSlashCommands, type ClaudeSdkCommand } from '../slash-commands'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * The choices a `can_use_tool` request offers, using the decision vocabulary
 * the CLI's control layer already understands so a response passes straight
 * through. `allow` answers one call; `always-allow` persists a session-scoped
 * allow rule for the tool (see `buildApprovalResponseFrame`).
 */
export const CLAUDE_APPROVAL_OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always-allow', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
] as const

/**
 * Maps Claude Code `--output-format stream-json` lines onto normalized
 * AgentEvents. Pure and total: malformed lines surface as error events, never
 * throws. See __fixtures__ for real recorded shapes. Runs with
 * `--include-partial-messages`, so realtime deltas arrive as stream_event
 * lines and the trailing finalized assistant message's text/thinking blocks
 * are skipped to avoid duplicates; tool_use still maps from the finalized
 * message where its input JSON is complete.
 */

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/** `request` body of a control_request line; only the fields we act on. */
export interface ControlRequestBody {
  subtype?: string
  tool_name?: string
  input?: unknown
}

interface StreamDelta {
  type?: string
  text?: string
  thinking?: string
}

export interface NativeLine {
  type?: string
  subtype?: string
  request_id?: string
  request?: ControlRequestBody
  session_id?: string
  /** Set on lines a subagent produced; null for the main conversation. */
  parent_tool_use_id?: string | null
  /** The task id of the subagent that produced the line. */
  agent_id?: string
  error?: string
  is_error?: boolean
  uuid?: string
  user_message_uuid?: string
  user_message_uuids?: string[]
  origin?: { kind?: string }
  message?: {
    id?: string
    /** `<synthetic>` marks text the CLI wrote itself, e.g. a local command's output. */
    model?: string
    content?: ContentBlock[]
    usage?: Record<string, unknown>
  }
  event?: {
    type?: string
    delta?: StreamDelta
    usage?: Record<string, unknown>
    message?: { id?: string; usage?: Record<string, unknown> }
  }
  usage?: Record<string, unknown>
  modelUsage?: Record<string, Record<string, unknown> | undefined>
  total_cost_usd?: number
  result?: string
  tool_use_result?: unknown
  task_id?: string
  tool_use_id?: string
  task_type?: string
  subagent_type?: string
  description?: string
  /** What a subagent run was asked (task_started). */
  prompt?: string
  summary?: string
  last_tool_name?: string
  status?: string
  is_backgrounded?: boolean
  ambient?: boolean
  skip_transcript?: boolean
  run_id?: string
  patch?: Record<string, unknown>
  tasks?: NativeLine[]
  errors?: string[]
  terminal_reason?: string
  /** `local_command_output`: what a local slash command printed. */
  content?: unknown
  /** `commands_changed`: the session's full command list, replacing the last one. */
  commands?: ClaudeSdkCommand[]
  /** `system/init`: commands bound to the terminal, and the skills loaded. */
  terminal_slash_commands?: string[]
  skills?: string[]
  num_turns?: number
  permissionMode?: string
  tool_name?: string
  elapsed_time_seconds?: number
  rate_limit_info?: {
    status?: string
    rateLimitType?: string
    utilization?: number
    resetsAt?: number
  }
}

function count(raw: Record<string, unknown> | undefined, key: string): number {
  const value = raw?.[key]
  return typeof value === 'number' ? value : 0
}

/**
 * Claude reports cache traffic beside `input_tokens`, not inside it: a long
 * session reads almost its whole prompt from cache, so `input_tokens` alone
 * is a handful of tokens however large the conversation is.
 */
function usageFrom(raw: Record<string, unknown> | undefined): {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
} {
  const cached = count(raw, 'cache_read_input_tokens')
  return {
    inputTokens: count(raw, 'input_tokens') + count(raw, 'cache_creation_input_tokens') + cached,
    outputTokens: count(raw, 'output_tokens'),
    cachedInputTokens: cached,
  }
}

/** What one model call left in the window: its whole prompt plus its reply. */
function contextUsed(call: Record<string, unknown> | undefined): number | null {
  if (typeof call?.['input_tokens'] !== 'number') return null
  const usage = usageFrom(call)
  return usage.inputTokens + usage.outputTokens
}

/**
 * `modelUsage` lists every model the turn touched, subagents included. The
 * entry whose counts are the turn's own totals is the conversation's model.
 * Failing that, the one carrying the conversation re-reads it on every call,
 * so it is usually the one that read the most.
 */
function contextWindowFrom(
  modelUsage: NativeLine['modelUsage'],
  turn: Record<string, unknown> | undefined,
): number | null {
  let window: number | null = null
  let mostRead = -1
  for (const model of Object.values(modelUsage ?? {})) {
    const size = model?.['contextWindow']
    if (typeof size !== 'number' || size <= 0) continue
    if (
      typeof turn?.['input_tokens'] === 'number' &&
      count(model, 'inputTokens') === count(turn, 'input_tokens') &&
      count(model, 'outputTokens') === count(turn, 'output_tokens') &&
      count(model, 'cacheReadInputTokens') === count(turn, 'cache_read_input_tokens')
    ) {
      return size
    }
    const read =
      count(model, 'inputTokens') +
      count(model, 'cacheReadInputTokens') +
      count(model, 'cacheCreationInputTokens')
    if (read > mostRead) {
      mostRead = read
      window = size
    }
  }
  return window
}

/** Maps one JSONL line. Returns zero or more normalized events. */
export function mapClaudeLine(line: string): AgentEvent[] {
  let parsed: NativeLine
  try {
    parsed = JSON.parse(line) as NativeLine
  } catch (e) {
    return [{ type: 'error', message: `unparseable line: ${formatUnknownError(e)}`, rawJson: null }]
  }

  return mapClaudeMessage(parsed)
}

/** SDK messages and recorded stream-json frames share their native payload schema. */
export function mapClaudeMessage(parsed: NativeLine): AgentEvent[] {
  const events: AgentEvent[] = []

  // Native agents have their own transcript. Their prose and tools go there,
  // and their usage and errors must not become the parent's reply.
  if (parsed.parent_tool_use_id != null && parsed.type !== 'control_request')
    return subagentEvents(parsed, parsed.parent_tool_use_id)

  if (typeof parsed.error === 'string' && parsed.error.length > 0) {
    events.push({
      type: 'error',
      message: `${parsed.error}: ${extractText(parsed)}`,
      rawJson: null,
    })
    return events
  }

  switch (parsed.type) {
    case 'system': {
      // system/init carries the CLI's own session id; surfacing it as the
      // provider ref lets later turns --resume instead of losing context.
      if (
        parsed.subtype === 'init' &&
        typeof parsed.session_id === 'string' &&
        parsed.session_id.length > 0
      ) {
        events.push({ type: 'session-ref', ref: parsed.session_id })
      }
      break
    }

    case 'stream_event': {
      // --include-partial-messages: realtime deltas. The finalized assistant
      // lines still follow, so whole-message text/thinking blocks there are
      // skipped to avoid duplicates (same strategy as the grok driver).
      const delta = parsed.event?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        events.push({ type: 'text-delta', text: delta.text })
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        events.push({ type: 'thinking-delta', text: delta.thinking })
      }
      // message_delta closes one model call with that call's own usage. A
      // subagent's calls fill its window, not the conversation's.
      if (parsed.event?.type === 'message_delta' && parsed.parent_tool_use_id == null) {
        const used = contextUsed(parsed.event.usage)
        if (used !== null) {
          events.push({ type: 'context-usage', usedTokens: used, windowTokens: null })
        }
      }
      break
    }

    case 'assistant': {
      for (const block of parsed.message?.content ?? []) {
        if (block.type === 'tool_use' && block.id && block.name) {
          events.push({
            type: 'tool-started',
            callId: block.id,
            name: block.name,
            argsJson: JSON.stringify(block.input ?? {}),
          })
        }
      }
      break
    }

    case 'user': {
      for (const block of parsed.message?.content ?? []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            type: 'tool-completed',
            callId: block.tool_use_id,
            resultJson: JSON.stringify(block.content ?? null),
            isError: block.is_error === true,
          })
          events.push(...imageOutputEvents(block.content))
        }
      }
      break
    }

    case 'control_request': {
      // With --permission-prompt-tool stdio the CLI asks the host to approve
      // each gated tool call. request_id doubles as Ari's approvalId.
      if (
        parsed.request?.subtype === 'can_use_tool' &&
        typeof parsed.request_id === 'string' &&
        parsed.request_id.length > 0
      ) {
        events.push({
          type: 'approval-requested',
          approvalId: parsed.request_id,
          toolName: parsed.request.tool_name ?? 'unknown',
          summaryJson: JSON.stringify(parsed.request.input ?? {}),
          options: [...CLAUDE_APPROVAL_OPTIONS],
        })
      }
      break
    }

    case 'result': {
      const usage = usageFrom(parsed.usage)
      events.push({
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      })
      // The window size only arrives here; `iterations` ends on the turn's
      // final call, which restates the reading that size belongs to.
      const iterations = parsed.usage?.['iterations']
      const used = contextUsed(
        Array.isArray(iterations)
          ? (iterations[iterations.length - 1] as Record<string, unknown> | undefined)
          : undefined,
      )
      if (used !== null) {
        events.push({
          type: 'context-usage',
          usedTokens: used,
          windowTokens: contextWindowFrom(parsed.modelUsage, parsed.usage),
        })
      }
      const interrupted =
        parsed.terminal_reason === 'aborted_tools' ||
        parsed.terminal_reason === 'aborted_streaming' ||
        (parsed.subtype === 'error_during_execution' &&
          /abort|interrupt|cancel/i.test(parsed.errors?.join(' ') ?? ''))
      if (!interrupted && (parsed.is_error === true || parsed.subtype?.startsWith('error_'))) {
        events.push({ type: 'error', message: extractText(parsed), rawJson: null })
      }
      events.push(interrupted ? { type: 'done', stopReason: 'interrupted' } : { type: 'done' })
      break
    }
  }

  return events
}

/**
 * A sub-agent's finalized messages, wrapped for its own transcript. Its
 * streaming frames are not used: the finalized message carries the same text,
 * and sub-agents are not watched token by token.
 */
function subagentEvents(line: NativeLine, taskId: string): AgentEvent[] {
  const activity: SubagentActivity[] = []
  if (line.type === 'assistant' && !line.error) {
    for (const block of line.message?.content ?? []) {
      if (block.type === 'text' && block.text)
        activity.push({ type: 'text-delta', text: block.text })
      else if (block.type === 'thinking' && block.thinking)
        activity.push({ type: 'thinking-delta', text: block.thinking })
      else if (block.type === 'tool_use' && block.id && block.name)
        activity.push({
          type: 'tool-started',
          callId: block.id,
          name: block.name,
          argsJson: JSON.stringify(block.input ?? {}),
        })
    }
  } else if (line.type === 'user') {
    for (const block of line.message?.content ?? []) {
      if (block.type === 'tool_result' && block.tool_use_id)
        activity.push({
          type: 'tool-completed',
          callId: block.tool_use_id,
          resultJson: JSON.stringify(block.content ?? null),
          isError: block.is_error === true,
        })
    }
  }
  return activity.map((event) => ({ type: 'subagent-activity', taskId, event }))
}

function extractText(line: NativeLine): string {
  for (const block of line.message?.content ?? []) {
    if (block.type === 'text' && block.text) return block.text
  }
  return typeof line.result === 'string'
    ? line.result
    : line.errors?.join('\n') || 'unknown provider error'
}

/** Maps a whole stream of lines in order. */
export function mapClaudeStream(lines: Iterable<string>): AgentEvent[] {
  return Array.from(lines).flatMap((line) => mapClaudeLine(line))
}

/** Streaming deltas plus finalized fallbacks, with query-cumulative accounting. */
export class ClaudeMessageMapper {
  readonly #seen = new Set<string>()
  readonly #tools = new Set<string>()
  readonly #streamed = new Map<string, { text: string; thinking: string }>()
  #messageId = 'current'
  #cost = 0
  #modelTotals = new Map<string, { input: number; output: number; cached: number }>()
  #contextCall: Record<string, unknown> | undefined
  #terminalCommands: string[] = []
  #skills: string[] = []
  #lastCommands: readonly ClaudeSdkCommand[] | null = null

  /** Cold resume reports cumulative historical totals; establish the baseline before sending. */
  seedUsage(cost: number, models: NativeLine['modelUsage']): void {
    this.#cost = cost
    this.#modelTotals = new Map(
      Object.entries(models ?? {}).map(([id, model]) => [
        id,
        {
          input:
            count(model, 'inputTokens') +
            count(model, 'cacheReadInputTokens') +
            count(model, 'cacheCreationInputTokens'),
          output: count(model, 'outputTokens'),
          cached: count(model, 'cacheReadInputTokens'),
        },
      ]),
    )
  }

  map(message: SDKMessage): AgentEvent[] {
    const native = message as unknown as NativeLine
    if (!native || typeof native !== 'object') throw new Error('Invalid Claude SDK message')
    if (native.uuid) {
      if (this.#seen.has(native.uuid)) return []
      this.#remember(this.#seen, native.uuid)
    }
    if (native.parent_tool_use_id != null) return mapClaudeMessage(native)
    const events = mapClaudeMessage(native)
    if (native.type === 'stream_event') {
      if (native.event?.type === 'message_start') {
        this.#messageId = native.event.message?.id ?? 'current'
        this.#streamed.set(this.#messageId, { text: '', thinking: '' })
        this.#contextCall = native.event.message?.usage
      }
      const streamed = this.#streamed.get(this.#messageId) ?? { text: '', thinking: '' }
      for (const event of events) {
        if (event.type === 'text-delta') streamed.text += event.text
        if (event.type === 'thinking-delta') streamed.thinking += event.text
      }
      this.#streamed.set(this.#messageId, streamed)
      if (native.event?.type === 'message_delta') {
        this.#contextCall = { ...this.#contextCall, ...native.event.usage }
        const used = contextUsed(this.#contextCall)
        if (used !== null && !events.some((event) => event.type === 'context-usage'))
          events.push({ type: 'context-usage', usedTokens: used, windowTokens: null })
      }
    }
    if (native.type === 'assistant' && !native.error && native.message?.model === '<synthetic>') {
      // A local slash command (/context, /usage) answers without the model:
      // the CLI's own report reads as a notice, not as the assistant talking.
      const output = (native.message.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('')
        .trim()
      if (output.length > 0) events.push({ type: 'notice', message: output })
    } else if (native.type === 'assistant' && !native.error) {
      if (native.message?.usage) this.#contextCall = native.message.usage
      const id = native.message?.id ?? this.#messageId
      const streamId = this.#streamed.has(id) ? id : this.#messageId
      const streamed = this.#streamed.get(streamId) ?? { text: '', thinking: '' }
      for (const block of native.message?.content ?? []) {
        const kind = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : null
        if (!kind) continue
        const text = (kind === 'text' ? block.text : block.thinking) ?? ''
        const delivered = streamed[kind]
        if (delivered.startsWith(text)) streamed[kind] = delivered.slice(text.length)
        else {
          const remaining = text.startsWith(delivered) ? text.slice(delivered.length) : text
          if (remaining)
            events.push({
              type: kind === 'text' ? 'text-delta' : 'thinking-delta',
              text: remaining,
            })
          streamed[kind] = ''
        }
      }
      this.#streamed.set(streamId, streamed)
    }
    if (native.type === 'result') {
      const cumulative = new Map<string, { input: number; output: number; cached: number }>()
      let input = 0,
        output = 0,
        cached = 0
      for (const [modelId, model] of Object.entries(native.modelUsage ?? {})) {
        if (!model) continue
        const total = {
          input:
            count(model, 'inputTokens') +
            count(model, 'cacheReadInputTokens') +
            count(model, 'cacheCreationInputTokens'),
          output: count(model, 'outputTokens'),
          cached: count(model, 'cacheReadInputTokens'),
        }
        let previous = this.#modelTotals.get(modelId)
        // /clear resets the CLI's cumulative counters inside the same query.
        if (
          previous &&
          (total.input < previous.input ||
            total.output < previous.output ||
            total.cached < previous.cached)
        )
          previous = undefined
        input += Math.max(0, total.input - (previous?.input ?? 0))
        output += Math.max(0, total.output - (previous?.output ?? 0))
        cached += Math.max(0, total.cached - (previous?.cached ?? 0))
        cumulative.set(modelId, total)
      }
      if (cumulative.size > 0) this.#modelTotals = cumulative
      const usage = events.find((event) => event.type === 'usage')
      if (!events.some((event) => event.type === 'context-usage')) {
        const used = contextUsed(this.#contextCall)
        if (used !== null)
          events.splice(Math.max(0, events.length - 1), 0, {
            type: 'context-usage',
            usedTokens: used,
            windowTokens: contextWindowFrom(native.modelUsage, native.usage),
          })
      }
      if (usage?.type === 'usage') {
        if (cumulative.size > 0) {
          usage.inputTokens = input
          usage.outputTokens = output
          usage.cachedInputTokens = cached
        }
        if (typeof native.total_cost_usd === 'number') {
          usage.costUsd =
            native.total_cost_usd < this.#cost
              ? native.total_cost_usd
              : native.total_cost_usd - this.#cost
          this.#cost = native.total_cost_usd
        }
      }
      this.#streamed.clear()
    }
    if (native.type === 'rate_limit_event' && native.rate_limit_info) {
      const info = native.rate_limit_info
      if (info.status !== 'allowed') {
        const utilization =
          typeof info.utilization === 'number'
            ? ` (${Math.round(info.utilization * 100)}% used)`
            : ''
        const reset =
          typeof info.resetsAt === 'number'
            ? `; resets ${new Date(info.resetsAt * 1000).toISOString()}`
            : ''
        events.push({
          type: 'notice',
          message: `Claude ${info.rateLimitType ?? 'usage'} limit: ${info.status ?? 'unknown'}${utilization}${reset}`,
        })
      }
    }
    if (native.type === 'system' && native.permissionMode) {
      if (native.permissionMode === 'plan')
        events.push({ type: 'notice', message: 'Claude entered plan mode.' })
      else if (
        native.permissionMode === 'default' ||
        native.permissionMode === 'acceptEdits' ||
        native.permissionMode === 'bypassPermissions'
      ) {
        events.push({
          type: 'permission-mode',
          mode:
            native.permissionMode === 'default'
              ? 'ask'
              : native.permissionMode === 'acceptEdits'
                ? 'allow-edits'
                : 'full',
        })
      }
    }
    if (native.type === 'system' && native.subtype === 'compact_boundary')
      events.push({ type: 'notice', message: 'Claude compacted the conversation context.' })
    // A local command's output (/context, /usage) is the CLI talking, not
    // the model: it renders as a notice, never as assistant prose.
    if (native.type === 'system' && native.subtype === 'local_command_output') {
      const output = typeof native.content === 'string' ? native.content.trim() : ''
      if (output.length > 0) events.push({ type: 'notice', message: output })
    }
    if (native.type === 'system' && native.subtype === 'init') {
      this.#terminalCommands = native.terminal_slash_commands ?? this.#terminalCommands
      this.#skills = native.skills ?? this.#skills
      // Init names the skills and terminal-bound commands; restate the list with them.
      if (this.#lastCommands !== null) events.push(this.commandsEvent(this.#lastCommands))
    }
    if (
      native.type === 'system' &&
      native.subtype === 'commands_changed' &&
      Array.isArray(native.commands)
    )
      events.push(this.commandsEvent(native.commands))
    return events.filter((event) => {
      if (event.type !== 'tool-started') return true
      if (this.#tools.has(event.callId)) return false
      this.#remember(this.#tools, event.callId)
      return true
    })
  }

  /** The session's commands as Ari runs them, with what init said about them. */
  commandsEvent(commands: readonly ClaudeSdkCommand[], skills: readonly string[] = []): AgentEvent {
    this.#lastCommands = commands
    return {
      type: 'commands',
      commands: claudeSlashCommands(commands, {
        terminal: this.#terminalCommands,
        skills: [...this.#skills, ...skills],
      }),
    }
  }

  #remember(set: Set<string>, id: string): void {
    set.add(id)
    if (set.size > 512) set.delete(set.values().next().value!)
  }
}

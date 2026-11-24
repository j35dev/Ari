import type { SDKMessage } from '@qoder-ai/qoder-agent-sdk'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { imageOutputEvents } from '../image-output'
import { claudeSlashCommands } from '../slash-commands'
import { ClaudeBackgroundTasks } from '../claude/background-tasks'
import type { NativeLine } from '../claude/mapper'

type TextEvent = Extract<AgentEvent, { type: 'text-delta' | 'thinking-delta' }>
interface StreamContext {
  message: string
  completeReply: boolean
  toolRequest: boolean
  latestTextStream: string | null
  closed: boolean
  blocks: Map<number, { kind: string; id?: string; name?: string; input: string; text?: string }>
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const string = (value: unknown): string => (typeof value === 'string' ? value : '')
/** Maps SDK block streams and authoritative messages without appending the final text twice. */
export class QoderMessageMapper {
  #round = 0
  readonly #toolNames = new Map<string, string>()
  #input = 0
  #output = 0
  #cost = 0
  #thread = ''
  readonly #settled = new Set<string>()
  readonly #contexts = new Map<string, StreamContext>()
  readonly #results = new Map<string, string>()
  readonly #background = new ClaudeBackgroundTasks('Qoder', { nativeBookends: true })
  readonly tasks = new Map<
    string,
    { nativeId: string | null; event: Extract<AgentEvent, { type: 'background-task' }> }
  >()

  beginTurn(): void {
    for (const key of this.#contexts.keys()) if (key.endsWith(':root')) this.#contexts.delete(key)
  }
  taskIdOf(id: string | null | undefined): string | null {
    return this.#background.taskIdOf(id)
  }
  #stream(
    thread: string,
    parent: string,
    context: StreamContext,
    kind: string,
    index: number,
  ): string {
    return `qoder:${thread}:${parent}:${context.message}:${kind}:${index}`
  }
  map(message: SDKMessage): AgentEvent[] {
    const events: AgentEvent[] = []
    const thread = string(message.session_id)
    const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
    const scope = parent || 'root'
    let native = message as unknown as NativeLine
    if (message.type === 'system' && message.subtype === 'task_started' && !message.task_type) {
      const name = this.#toolNames.get(message.tool_use_id ?? '')
      if (name === 'Agent' || name === 'Task') native = { ...native, task_type: 'local_agent' }
    }
    const background = this.#background.observe(native)
    const key = `${thread}:${scope}`
    let context = this.#contexts.get(key)
    if (!context) {
      context = {
        message: '',
        completeReply: false,
        toolRequest: false,
        latestTextStream: null,
        closed: false,
        blocks: new Map(),
      }
      this.#contexts.set(key, context)
    }
    if (!parent && thread && thread !== this.#thread) {
      this.#thread = thread
      events.push({ type: 'session-ref', ref: thread })
    }
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') {
        context.message = string(record(event.message).id) || `round-${++this.#round}`
        if (parent && string(record(event.message).model))
          background.push(
            ...this.#background.observe({
              type: 'assistant',
              parent_tool_use_id: parent,
              message: { model: string(record(event.message).model), content: [] },
            }),
          )
        context.blocks.clear()
        context.completeReply = false
        context.toolRequest = false
        context.latestTextStream = null
        context.closed = false
      } else if (event.type === 'content_block_start') {
        if (!context.message) context.message = `round-${++this.#round}`
        const block = record(event.content_block)
        const id = string(block.id),
          name = string(block.name)
        context.blocks.set(event.index ?? 0, {
          kind: string(block.type),
          ...(block.type === 'tool_use' && id && name ? { id, name } : {}),
          input: '',
          ...(block.type === 'text' || block.type === 'thinking'
            ? { text: string(block.type === 'text' ? block.text : block.thinking) }
            : {}),
        })
        if (block.type === 'text' || block.type === 'thinking') {
          const value = string(block.type === 'text' ? block.text : block.thinking)
          if (value)
            events.push({
              type: block.type === 'text' ? 'text-delta' : 'thinking-delta',
              text: value,
              streamId: this.#stream(thread, scope, context, block.type, event.index ?? 0),
            })
        }
        if (block.type === 'tool_use' && id && name) {
          context.toolRequest = true
          this.#toolNames.set(id, name)
          events.push({
            type: 'tool-started',
            callId: id,
            name,
            argsJson: JSON.stringify(block.input ?? {}),
          })
        }
      } else if (event.type === 'content_block_delta') {
        if (context.closed) return events
        const delta = record(event.delta)
        if (!context.message) context.message = `round-${++this.#round}`
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          const kind = delta.type === 'text_delta' ? 'text' : 'thinking'
          const part: TextEvent = {
            type: kind === 'text' ? 'text-delta' : 'thinking-delta',
            text: string(delta.type === 'text_delta' ? delta.text : delta.thinking),
            streamId: this.#stream(thread, scope, context, kind, event.index ?? 0),
          }
          const block = context.blocks.get(event.index ?? 0) ?? { kind, input: '', text: '' }
          block.text = (block.text ?? '') + part.text
          context.blocks.set(event.index ?? 0, block)
          if (kind === 'text' && !message.parent_tool_use_id) {
            context.latestTextStream = part.streamId ?? null
          }
          events.push(part)
        } else if (delta.type === 'input_json_delta') {
          const block = context.blocks.get(event.index ?? 0)
          if (block?.id && block.name) {
            block.input += string(delta.partial_json)
            try {
              events.push({
                type: 'tool-started',
                callId: block.id,
                name: block.name,
                argsJson: JSON.stringify(JSON.parse(block.input)),
              })
            } catch {
              /* Partial JSON is retained until it becomes valid. */
            }
          }
        }
      }
    } else if (message.type === 'assistant') {
      // Synthesized API failure messages can precede an automatic retry. The
      // terminal Result owns failure; do not duplicate its text or fail a retry.
      if (message.isApiErrorMessage) return events
      context.closed = true
      context.message = string(message.message.id) || context.message || `round-${++this.#round}`
      if (!message.parent_tool_use_id)
        context.completeReply =
          message.message.content.some(
            (block) => block.type === 'text' && typeof block.text === 'string',
          ) && !message.message.content.some((block) => block.type === 'tool_use')
      for (const [index, block] of message.message.content.entries()) {
        if (block.type === 'text' || block.type === 'thinking') {
          if (typeof (block.type === 'text' ? block.text : block.thinking) !== 'string') continue
          const text = string(block.type === 'text' ? block.text : block.thinking)
          const prior = context.blocks.get(index)?.text ?? ''
          const append = text.startsWith(prior)
          const remaining = append ? text.slice(prior.length) : text
          if (remaining || !append)
            events.push({
              type: block.type === 'text' ? 'text-delta' : 'thinking-delta',
              text: remaining,
              streamId: this.#stream(thread, scope, context, block.type, index),
              ...(!append ? { replace: true } : {}),
            })
          context.blocks.set(index, { kind: block.type, input: '', text })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          context.toolRequest = true
          this.#toolNames.set(block.id, block.name)
          events.push({
            type: 'tool-started',
            callId: block.id,
            name: block.name,
            argsJson: JSON.stringify(block.input ?? {}),
          })
        }
      }
    } else if (message.type === 'user') {
      const content = message.message.content
      if (Array.isArray(content))
        for (const block of content) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          const value = JSON.stringify(block.content ?? null)
          const signature = `${block.is_error === true}:${value}`
          if (this.#results.get(block.tool_use_id) === signature) continue
          this.#results.set(block.tool_use_id, signature)
          events.push(
            {
              type: 'tool-completed',
              callId: block.tool_use_id,
              resultJson: value,
              isError: block.is_error === true,
            },
            ...imageOutputEvents(block.content),
          )
        }
    } else if (message.type === 'tool_progress') {
      if (this.#results.has(message.tool_use_id)) return events
      if (message.output !== undefined)
        events.push({
          type: 'tool-progress',
          callId: message.tool_use_id,
          resultJson: JSON.stringify(message.output),
        })
    } else if (message.type === 'result') {
      if (this.#settled.has(message.uuid)) return []
      this.#settled.add(message.uuid)
      if (this.#settled.size > 512) this.#settled.delete(this.#settled.values().next().value!)
      const usage = message.usage
      const input =
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      const output = usage.output_tokens
      events.push({
        type: 'usage',
        inputTokens: Math.max(0, input - this.#input),
        outputTokens: Math.max(0, output - this.#output),
        costUsd: Math.max(0, message.total_cost_usd - this.#cost),
      })
      this.#input = input
      this.#output = output
      this.#cost = message.total_cost_usd
      if (message.subtype === 'success' && !context.completeReply && message.result)
        events.push({
          type: 'text-delta',
          text: message.result,
          streamId:
            !context.toolRequest && context.latestTextStream
              ? context.latestTextStream
              : `qoder:${thread}:result:${message.uuid}`,
          replace: true,
        })
      if (message.is_error || message.subtype !== 'success')
        events.push({
          type: 'error',
          message:
            'errors' in message
              ? message.errors.join('\n') || 'Qoder turn failed.'
              : 'Qoder turn failed.',
          rawJson: null,
        })
      events.push({
        type: 'done',
        stopReason:
          message.is_error || message.subtype !== 'success'
            ? 'error'
            : message.terminal_reason === 'interrupted' || message.terminal_reason === 'cancelled'
              ? 'interrupted'
              : 'completed',
      })
    } else if (message.type === 'system') {
      if (message.subtype === 'commands_changed')
        events.push({ type: 'commands', commands: claudeSlashCommands(message.commands) })
      else if (message.subtype === 'compact_boundary')
        events.push({ type: 'notice', message: 'Qoder compacted the conversation context.' })
    }
    // A streaming Agent announcement can precede its task bookend. Track the
    // launch immediately, then reconcile native IDs onto that same task row.
    for (const event of events)
      if (event.type === 'tool-started') {
        let input: unknown = {}
        try {
          input = JSON.parse(event.argsJson)
        } catch {
          /* Keep the partial launch. */
        }
        background.push(
          ...this.#background.observe({
            type: 'assistant',
            parent_tool_use_id: parent,
            message: { content: [{ type: 'tool_use', id: event.callId, name: event.name, input }] },
          }),
        )
      }
    for (const [index, event] of background.entries())
      if (event.type === 'background-task') {
        const report = { ...event, ...(thread ? { providerThreadId: thread } : {}) }
        background[index] = report
        const prior = this.tasks.get(event.id)
        this.tasks.set(event.id, {
          nativeId: this.#background.nativeIdOf(event.id) ?? prior?.nativeId ?? null,
          event: { ...prior?.event, ...report },
        })
      }
    events.push(...background)
    // Native ID binding can change without a display change, so the shared
    // tracker may dedupe its report. Keep control targets current regardless.
    for (const [id, task] of this.tasks) {
      if (this.#background.taskIdOf(id) !== id) this.tasks.delete(id)
      else task.nativeId = this.#background.nativeIdOf(id) ?? task.nativeId
    }
    if (!parent) return events
    const taskId = this.#background.taskIdOf(parent) ?? parent
    return [
      ...background,
      ...events
        .filter((event) => event.type !== 'background-task')
        .flatMap((event) =>
          event.type === 'text-delta' ||
          event.type === 'thinking-delta' ||
          event.type === 'tool-started' ||
          event.type === 'tool-progress' ||
          event.type === 'tool-completed'
            ? [{ type: 'subagent-activity' as const, taskId, event }]
            : [],
        ),
    ]
  }
}

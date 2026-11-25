import { fileURLToPath } from 'node:url'
import type { AgentEvent, SubagentActivity } from '@ari/contracts/agent-event'
import { MAX_SUBAGENT_TEXT } from '@ari/contracts/background-task'
import { encodeQuestionnaire } from '../acp/client-requests'
import { imageOutputEvents } from '../image-output'
import type { OcEvent, OcTokens } from './wire'

/**
 * Maps one turn's OpenCode server events onto Ari's AgentEvents, the way the
 * Claude driver reports a turn: streamed text and thinking, tools with their
 * inputs and outputs, approvals, questions, usage, and sub-agents (OpenCode's
 * child sessions) as background tasks with their own activity.
 *
 * Stateful per turn and total: an event for another session maps to nothing.
 */
export interface MappedEvents {
  events: AgentEvent[]
  /** Set when the root session finished its work. */
  end?: 'completed' | 'interrupted' | 'error'
}

interface Child {
  taskId: string
  label: string
  agent?: string
}

export const PERMISSION_OPTIONS = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
] as const

export function usageEvents(tokens: OcTokens, cost: number | null, context: boolean): AgentEvent[] {
  // OpenCode keeps cache traffic and reasoning out of `input`/`output`.
  const cached = tokens.cache.read
  const input = tokens.input + tokens.cache.write + cached
  const output = tokens.output + tokens.reasoning
  const events: AgentEvent[] = [
    {
      type: 'usage',
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      costUsd: cost,
    },
  ]
  if (context && input + output > 0)
    events.push({ type: 'context-usage', usedTokens: input + output, windowTokens: null })
  return events
}

function fileEvents(files: { uri: string; mime: string; name?: string | null }[]): AgentEvent[] {
  return files.flatMap((file, index): AgentEvent[] => {
    if (!/^image\/[a-z0-9.+-]+$/.test(file.mime)) return []
    const name = file.name || `image-${index + 1}`
    if (file.uri.startsWith('file:')) {
      try {
        return [
          { type: 'image-output-path', path: fileURLToPath(file.uri), mimeType: file.mime, name },
        ]
      } catch {
        return []
      }
    }
    const data = /^data:[^;,]+;base64,(.+)$/.exec(file.uri)?.[1]
    return data ? [{ type: 'image-output', dataBase64: data, mimeType: file.mime, name }] : []
  })
}

export class OpencodeTurnMapper {
  readonly #children = new Map<string, Child>()
  /** Characters of each text/reasoning part already sent. */
  readonly #sent = new Map<string, number>()
  readonly #tools = new Map<string, { started: boolean; name: string }>()
  #retry = -1
  #lastText = new Map<string, string>()

  constructor(readonly rootSessionID: string) {}

  /** Whether events of `sessionID` belong to this turn. */
  owns(sessionID: string): boolean {
    return sessionID === this.rootSessionID || this.#children.has(sessionID)
  }

  taskIdOf(sessionID: string): string | undefined {
    return this.#children.get(sessionID)?.taskId
  }

  /** Sub-agents still running when the turn ended. */
  runningChildren(): string[] {
    return [...this.#children.keys()]
  }

  map(event: OcEvent): MappedEvents {
    if (event.type === 'session') return { events: this.#session(event) }
    const sessionID = event.sessionID ?? ''
    if (!this.owns(sessionID)) return { events: [] }
    const child = sessionID === this.rootSessionID ? undefined : this.#children.get(sessionID)
    switch (event.type) {
      case 'text':
      case 'reasoning': {
        const text = this.#text(event)
        if (text.length === 0) return { events: [] }
        if (child) this.#lastText.set(sessionID, (this.#lastText.get(sessionID) ?? '') + text)
        const delta: SubagentActivity =
          event.type === 'text'
            ? { type: 'text-delta', text, streamId: event.partID }
            : { type: 'thinking-delta', text, streamId: event.partID }
        return { events: [this.#scope(child, delta)] }
      }
      case 'tool':
        return { events: this.#tool(event, child) }
      case 'usage':
        return { events: usageEvents(event.tokens, event.cost, child === undefined) }
      case 'retry': {
        if (child || event.attempt === this.#retry) return { events: [] }
        this.#retry = event.attempt
        return {
          events: [
            {
              type: 'notice',
              message: `OpenCode is retrying${event.attempt > 0 ? ` (attempt ${event.attempt})` : ''}: ${event.message}`,
            },
          ],
        }
      }
      case 'permission':
        return {
          events: [
            {
              type: 'approval-requested',
              approvalId: event.id,
              toolName: event.action,
              summaryJson: JSON.stringify({
                ...(event.resources.length > 0 ? { resources: event.resources } : {}),
                ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
              }),
              providerThreadId: sessionID,
              ...(event.callID ? { providerItemId: event.callID } : {}),
              ...(child ? { taskId: child.taskId } : {}),
              options: PERMISSION_OPTIONS.map((option) => ({ ...option })),
            },
          ],
        }
      case 'question':
        return {
          events: [
            {
              type: 'input-requested',
              inputId: event.id,
              prompt: event.prompt,
              choicesJson: encodeQuestionnaire({
                kind: 'questionnaire',
                questions: event.questions,
              }),
            },
          ],
        }
      case 'busy':
        return { events: [] }
      case 'error':
        // A sub-agent's failure reaches the parent through its task tool.
        return child
          ? { events: [] }
          : { events: [{ type: 'error', message: event.message, rawJson: null }] }
      case 'idle': {
        if (child) return { events: this.#childEnded(sessionID, child, event.outcome, event.error) }
        const events: AgentEvent[] =
          event.outcome === 'error'
            ? [{ type: 'error', message: event.error ?? 'OpenCode run failed', rawJson: null }]
            : []
        return { events, end: event.outcome }
      }
    }
  }

  #scope(child: Child | undefined, event: SubagentActivity): AgentEvent {
    return child ? { type: 'subagent-activity', taskId: child.taskId, event } : event
  }

  #session(event: Extract<OcEvent, { type: 'session' }>): AgentEvent[] {
    if (!event.parentID || !this.owns(event.parentID) || this.#children.has(event.sessionID))
      return []
    const child: Child = {
      taskId: `opencode-${event.sessionID}`,
      label: event.title ?? event.agent ?? 'Sub-agent',
      ...(event.agent ? { agent: event.agent } : {}),
    }
    this.#children.set(event.sessionID, child)
    return [
      {
        type: 'background-task',
        id: child.taskId,
        nativeTaskId: event.sessionID,
        providerThreadId: event.sessionID,
        kind: 'subagent',
        label: child.label,
        status: 'running',
        ...(child.agent ? { subagentType: child.agent } : {}),
      },
    ]
  }

  #childEnded(
    sessionID: string,
    child: Child,
    outcome: 'completed' | 'interrupted' | 'error',
    error: string | undefined,
  ): AgentEvent[] {
    this.#children.delete(sessionID)
    const result = this.#lastText.get(sessionID)
    this.#lastText.delete(sessionID)
    return [
      {
        type: 'background-task',
        id: child.taskId,
        nativeTaskId: sessionID,
        kind: 'subagent',
        label: child.label,
        status:
          outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'stopped' : 'failed',
        detail: outcome === 'error' ? (error ?? 'Failed') : null,
        ...(result ? { result: result.slice(-MAX_SUBAGENT_TEXT) } : {}),
      },
    ]
  }

  #text(event: Extract<OcEvent, { type: 'text' | 'reasoning' }>): string {
    const sent = this.#sent.get(event.partID) ?? 0
    if (event.delta !== undefined) {
      this.#sent.set(event.partID, sent + event.delta.length)
      return event.delta
    }
    // A whole part: send only what the deltas did not already deliver.
    const full = event.text ?? ''
    if (full.length <= sent) return ''
    this.#sent.set(event.partID, full.length)
    return full.slice(sent)
  }

  #tool(event: Extract<OcEvent, { type: 'tool' }>, child: Child | undefined): AgentEvent[] {
    const known = this.#tools.get(event.callID) ?? { started: false, name: 'tool' }
    if (event.name) known.name = event.name
    this.#tools.set(event.callID, known)
    if (event.status === 'pending') return []
    const out: SubagentActivity[] = []
    if (!known.started) {
      known.started = true
      out.push({
        type: 'tool-started',
        callId: event.callID,
        name: known.name,
        argsJson: JSON.stringify(event.input ?? {}),
      })
    }
    const extra: AgentEvent[] = []
    if (event.status === 'completed' || event.status === 'error') {
      this.#tools.delete(event.callID)
      const isError = event.status === 'error'
      out.push({
        type: 'tool-completed',
        callId: event.callID,
        resultJson: JSON.stringify(
          isError ? (event.error ?? event.output ?? '') : (event.output ?? ''),
        ),
        isError,
      })
      if (!child) extra.push(...imageOutputEvents(event.output), ...fileEvents(event.files ?? []))
    }
    return [...out.map((activity) => this.#scope(child, activity)), ...extra]
  }
}

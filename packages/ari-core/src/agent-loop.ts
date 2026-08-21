import type { AgentEvent } from '@ari/contracts/agent-event'
import type { ChatMessage } from './protocols/openai-chat'
import { findTool, type ToolContext } from './tools'

export interface AgentLoopOptions {
  /** Streams one model round: given messages, yields normalized events. */
  round: (messages: ChatMessage[], signal?: AbortSignal) => AsyncGenerator<AgentEvent>
  systemPrompt: string
  userPrompt: string
  workspacePath: string
  maxRounds?: number
  signal?: AbortSignal
}

interface PendingToolCall {
  callId: string
  name: string
  argsJson: string
}

/**
 * The Ari Core agent loop: stream a model round; when the model requests
 * tools, execute them (jailed), feed results back, and repeat until the
 * model finishes or the round budget is exhausted. All normalized events
 * pass through to the caller.
 */
export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent, void, undefined> {
  const { round, systemPrompt, userPrompt, workspacePath, maxRounds = 12, signal } = options
  const ctx: ToolContext = { workspacePath }
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  for (let current = 0; current < maxRounds; current++) {
    if (signal?.aborted) {
      yield { type: 'error', message: 'aborted', rawJson: null }
      yield { type: 'done' }
      return
    }

    const pending: PendingToolCall[] = []
    let sawDone = false

    for await (const event of round(messages, signal)) {
      if (event.type === 'tool-started') {
        pending.push({
          callId: event.callId,
          name: event.name,
          argsJson: event.argsJson,
        })
      }
      if (event.type === 'done') sawDone = true
      // usage/done are per-round; only forward done on the final round.
      if (event.type !== 'done') yield event
    }

    if (pending.length === 0) {
      yield { type: 'done' }
      return
    }
    if (sawDone && pending.length > 0) {
      // Model claimed completion while requesting tools — trust the tools.
    }

    // Record the assistant's tool calls, then execute and append results.
    const assistantToolCalls = pending.map((p) => ({
      id: p.callId,
      name: p.name,
      argsJson: p.argsJson,
    }))
    messages.push({ role: 'assistant', content: '', toolCalls: assistantToolCalls })

    for (const call of pending) {
      const tool = findTool(call.name)
      let resultJson: string
      let isError = false
      if (!tool) {
        isError = true
        resultJson = JSON.stringify(`unknown tool: ${call.name}`)
      } else {
        try {
          const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
          resultJson = JSON.stringify(await tool.execute(args, ctx))
        } catch (e) {
          isError = true
          resultJson = JSON.stringify(String(e))
        }
      }
      yield {
        type: 'tool-completed',
        callId: call.callId,
        resultJson,
        isError,
      }
      messages.push({
        role: 'tool',
        content: resultJson,
        toolCallId: call.callId,
      })
    }
  }

  yield { type: 'error', message: `round budget exhausted (${maxRounds})`, rawJson: null }
  yield { type: 'done' }
}

import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import type { AdapterApprovalDecision } from '@ari/providers/driver'
import { newId } from '@ari/shared/ids'
import type { ChatMessage } from './protocols/openai-chat'
import type { AllowRule } from './allowlist'
import { matchesAllowlist } from './allowlist'
import { checkPermission, MODE_GUARDED_TOOLS } from './permissions'
import {
  BUILT_IN_TOOLS,
  formatAskUserResult,
  parseAskUserToolArgs,
  type Tool,
  type ToolContext,
} from './tools'

export interface AgentLoopOptions {
  /** Streams one model round: given messages, yields normalized events. */
  round: (messages: ChatMessage[], signal?: AbortSignal) => AsyncGenerator<AgentEvent>
  systemPrompt: string
  userPrompt: string
  workspacePath: string
  /**
   * Prior turns of this session, without the system prompt. The loop replays
   * them ahead of `userPrompt` so the model keeps its memory across turns.
   */
  history?: ChatMessage[]
  /**
   * Receives the conversation (history plus this turn, system prompt excluded)
   * whenever it grows, so the caller can persist it. Called with a snapshot;
   * the loop never hands out its own array.
   */
  onTranscript?: (messages: ChatMessage[]) => void
  /**
   * Called with the full message list before every model round. Returning a
   * shorter list replaces the loop's own history, which is how compaction
   * lands: the summary survives, the summarized span does not. Returning the
   * same array is a no-op. The system prompt is always element 0.
   */
  compact?: (messages: ChatMessage[]) => Promise<ChatMessage[]>
  /**
   * Session permission mode (`ask` | `allow-edits` | `full`). Bash and file
   * writes are gated by it; an absent mode is treated as `ask` (fail-closed).
   */
  permissionMode?: PermissionMode
  /**
   * Permission rules enforced inside the tool context. Rules intersect with
   * the mode: a call must pass both to run.
   */
  allowlist?: AllowRule[]
  /**
   * Extra tools mounted for this run (e.g. MCP server tools), merged with
   * the built-ins for lookup. They count as external side effects: the
   * permission mode gates them like bash and allowlist rules bind by name.
   */
  extraTools?: Tool[]
  /**
   * Resolves mode-gated tool calls through the host approval flow. When
   * absent, mode-gated calls are denied outright instead of silently running.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<AdapterApprovalDecision>
  /**
   * Parks `ask_user_question` until the host answers via `input.respond`.
   * The loop emits `input-requested` itself so the QuestionPanel can mount.
   */
  requestInput?: (inputId: string) => Promise<string>
  maxRounds?: number
  /**
   * How many times an entirely empty model round (no text, no thinking, no
   * tool calls) is retried before the turn fails with a visible error.
   * An empty completion is a retryable provider hiccup, not a silent success
   * (DSH EMPTY_RESPONSE semantics). Default 2; 0 disables.
   */
  emptyResponseRetries?: number
  signal?: AbortSignal
}

export interface ApprovalRequest {
  approvalId: string
  toolName: string
  argsJson: string
}

interface PendingToolCall {
  callId: string
  name: string
  argsJson: string
}

/** One settled tool call, already shaped for the transcript. */
interface ToolOutcome {
  resultJson: string
  isError: boolean
}

/**
 * A tool may run alongside the other read-only calls of its batch when it
 * declares itself side-effect free. Guarded names never qualify, so an
 * extension cannot bypass approval by claiming to be read-only.
 */
function isConcurrencySafe(tool: Tool): boolean {
  return tool.readOnly === true && !MODE_GUARDED_TOOLS.has(tool.name)
}

/** Runs a tool, folding a thrown error into the result the model will see. */
async function executeTool(
  tool: Tool,
  argsJson: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    const args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    return { resultJson: JSON.stringify(await tool.execute(args, ctx)), isError: false }
  } catch (e) {
    return { resultJson: JSON.stringify(String(e)), isError: true }
  }
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
  // Fail-closed: an absent mode behaves as `ask`.
  const permissionMode: PermissionMode = options.permissionMode ?? 'ask'
  const extraTools = options.extraTools ?? []
  const extraNames = new Set(extraTools.map((t) => t.name))
  const toolset = new Map<string, Tool>(
    [...BUILT_IN_TOOLS, ...extraTools].map((t) => [t.name, t]),
  )
  const ctx: ToolContext = {
    workspacePath,
    permissionMode,
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
  }
  // Tools cleared by an `always-allow` decision run mode-unrestricted for the
  // rest of the loop; single approvals build a per-call context instead.
  const alwaysAllowed = new Set<string>()
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(options.history ?? []),
    { role: 'user', content: userPrompt },
  ]
  // The system prompt is rebuilt per turn (its environment facts go stale), so
  // it is never part of the persisted transcript.
  const publishTranscript = (): void => {
    options.onTranscript?.(messages.slice(1).map((m) => ({ ...m })))
  }
  publishTranscript()

  for (let current = 0; current < maxRounds; current++) {
    if (signal?.aborted) {
      yield { type: 'error', message: 'aborted', rawJson: null }
      yield { type: 'done' }
      return
    }

    // Compaction runs between rounds, where the message list is consistent —
    // never mid-round, which could separate a tool call from its results.
    if (options.compact) {
      const compacted = await options.compact(messages)
      if (compacted !== messages) {
        messages.length = 0
        messages.push(...compacted)
        publishTranscript()
      }
    }

    // Empty-response guard: a round with no content and no tool calls is
    // retried instead of ending the turn silently. Usage events are deferred
    // to the end of the round so an empty attempt's usage is never counted.
    const maxEmptyRetries = options.emptyResponseRetries ?? 2
    let emptyAttempts = 0
    let pending: PendingToolCall[]
    // Assigned at the top of every attempt, like `pending`: a retried round
    // replaces the text rather than appending to a discarded attempt's.
    let assistantText: string
    for (;;) {
      let sawContent = false
      const deferredUsage: AgentEvent[] = []
      // Whitespace-only deltas held back until real content shows up, so an
      // empty attempt never leaks stray fragments to the transcript.
      const deferredWhitespace: AgentEvent[] = []
      pending = []
      assistantText = ''

      for await (const event of round(messages, signal)) {
        if (event.type === 'tool-started') {
          pending.push({
            callId: event.callId,
            name: event.name,
            argsJson: event.argsJson,
          })
        }
        if (event.type === 'usage') {
          deferredUsage.push(event)
          continue
        }
        if (event.type === 'text-delta') assistantText += event.text
        if (
          (event.type === 'text-delta' || event.type === 'thinking-delta') &&
          !sawContent &&
          event.text.trim().length === 0
        ) {
          deferredWhitespace.push(event)
          continue
        }
        if (
          (event.type === 'text-delta' || event.type === 'thinking-delta') &&
          event.text.trim().length > 0
        ) {
          sawContent = true
        }
        // usage/done are per-round; only forward done on the final round.
        if (event.type !== 'done') yield event
      }

      if (!sawContent && pending.length === 0) {
        emptyAttempts++
        if (emptyAttempts > maxEmptyRetries) {
          yield {
            type: 'error',
            message: `model returned an empty response (${emptyAttempts} attempts)`,
            rawJson: null,
          }
          yield { type: 'done' }
          return
        }
        continue
      }

      for (const w of deferredWhitespace) yield w
      for (const u of deferredUsage) yield u
      break
    }

    if (pending.length === 0) {
      // A text-only round ends the turn; keep the answer in the transcript so
      // the next turn can refer back to it.
      if (assistantText.length > 0) {
        messages.push({ role: 'assistant', content: assistantText })
        publishTranscript()
      }
      yield { type: 'done' }
      return
    }

    // Record the assistant's tool calls, then execute and append results.
    const assistantToolCalls = pending.map((p) => ({
      id: p.callId,
      name: p.name,
      argsJson: p.argsJson,
    }))
    messages.push({ role: 'assistant', content: assistantText, toolCalls: assistantToolCalls })
    publishTranscript()

    // Read-only builtins cannot conflict with each other and never need
    // approval, so a fan-out (four reads, a grep and a glob) runs concurrently
    // instead of paying one round-trip each. Mutating and external tools stay
    // strictly ordered: their order is the model's intent, and two writes to
    // one file must not race. Results are still yielded in call order, so the
    // transcript and the message list are identical either way.
    const inFlight = new Map<string, Promise<ToolOutcome>>()
    for (const call of pending) {
      const tool = toolset.get(call.name)
      if (tool && isConcurrencySafe(tool)) {
        inFlight.set(call.callId, executeTool(tool, call.argsJson, ctx))
      }
    }

    for (const call of pending) {
      const tool = toolset.get(call.name)
      let resultJson: string
      let isError = false
      const concurrent = inFlight.get(call.callId)
      if (concurrent) {
        const outcome = await concurrent
        resultJson = outcome.resultJson
        isError = outcome.isError
      } else if (!tool) {
        isError = true
        resultJson = JSON.stringify(`unknown tool: ${call.name}`)
      } else if (call.name === 'ask_user_question') {
        const requestInput = options.requestInput
        try {
          const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
          const parsed = parseAskUserToolArgs(args)
          if (requestInput === undefined) {
            throw new Error('ask_user_question requires a host that can prompt the user')
          }
          const inputId = newId('q')
          const parked = requestInput(inputId)
          yield {
            type: 'input-requested',
            inputId,
            prompt: parsed.prompt,
            choicesJson: parsed.choicesJson,
          }
          const value = await parked
          resultJson = JSON.stringify(formatAskUserResult(parsed.questions, value))
        } catch (e) {
          isError = true
          resultJson = JSON.stringify(String(e))
        }
      } else {
        let execCtx: ToolContext = ctx
        try {
          const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
          const shellLike = extraNames.has(call.name)
          if (MODE_GUARDED_TOOLS.has(call.name) || shellLike) {
            // Extra tools enforce their allowlist here; built-ins re-check
            // inside their own execute.
            if (
              shellLike &&
              (ctx.allowlist ?? []).some((r) => r.tool === call.name) &&
              !matchesAllowlist(call.name, call.argsJson, ctx.allowlist ?? [])
            ) {
              throw new Error('blocked by permission allowlist')
            }
            if (alwaysAllowed.has(call.name)) {
              execCtx = { ...ctx, approvedTools: alwaysAllowed }
            } else {
              const decision = checkPermission(permissionMode, call.name, shellLike)
              if (!decision.allowed) {
                const requestApproval = options.requestApproval
                if (!requestApproval) {
                  throw new Error(`${decision.reason} (no approval handler configured)`)
                }
                const approvalId = newId('apv')
                // Register the parking spot before emitting, so a decision
                // that arrives while the consumer holds the event is not lost.
                const pendingDecision = requestApproval({
                  approvalId,
                  toolName: call.name,
                  argsJson: call.argsJson,
                })
                yield {
                  type: 'approval-requested',
                  approvalId,
                  toolName: call.name,
                  summaryJson: call.argsJson,
                }
                const verdict = await pendingDecision
                if (verdict === 'deny') {
                  throw new Error(
                    `denied by user under permission mode '${permissionMode}': ${call.name}`,
                  )
                }
                if (verdict === 'always-allow') {
                  alwaysAllowed.add(call.name)
                  execCtx = { ...ctx, approvedTools: alwaysAllowed }
                } else {
                  execCtx = { ...ctx, approvedTools: new Set([call.name]) }
                }
              }
            }
          }
          resultJson = JSON.stringify(await tool.execute(args, execCtx))
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
    publishTranscript()
  }

  yield { type: 'error', message: `round budget exhausted (${maxRounds})`, rawJson: null }
  yield { type: 'done' }
}

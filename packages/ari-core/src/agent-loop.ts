import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import type { AdapterApprovalDecision } from '@ari/providers/driver'
import { newId } from '@ari/shared/ids'
import type { ChatMessage } from './protocols/openai-chat'
import type { AllowRule } from './allowlist'
import { matchesAllowlist } from './allowlist'
import { checkPermission, MODE_GUARDED_TOOLS } from './permissions'
import { BUILT_IN_TOOLS, type Tool, type ToolContext } from './tools'

export interface AgentLoopOptions {
  /** Streams one model round: given messages, yields normalized events. */
  round: (messages: ChatMessage[], signal?: AbortSignal) => AsyncGenerator<AgentEvent>
  systemPrompt: string
  userPrompt: string
  workspacePath: string
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
    { role: 'user', content: userPrompt },
  ]

  for (let current = 0; current < maxRounds; current++) {
    if (signal?.aborted) {
      yield { type: 'error', message: 'aborted', rawJson: null }
      yield { type: 'done' }
      return
    }

    // Empty-response guard: a round with no content and no tool calls is
    // retried instead of ending the turn silently. Usage events are deferred
    // to the end of the round so an empty attempt's usage is never counted.
    const maxEmptyRetries = options.emptyResponseRetries ?? 2
    let emptyAttempts = 0
    let pending: PendingToolCall[]
    for (;;) {
      let sawContent = false
      const deferredUsage: AgentEvent[] = []
      // Whitespace-only deltas held back until real content shows up, so an
      // empty attempt never leaks stray fragments to the transcript.
      const deferredWhitespace: AgentEvent[] = []
      pending = []

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
      yield { type: 'done' }
      return
    }

    // Record the assistant's tool calls, then execute and append results.
    const assistantToolCalls = pending.map((p) => ({
      id: p.callId,
      name: p.name,
      argsJson: p.argsJson,
    }))
    messages.push({ role: 'assistant', content: '', toolCalls: assistantToolCalls })

    for (const call of pending) {
      const tool = toolset.get(call.name)
      let resultJson: string
      let isError = false
      if (!tool) {
        isError = true
        resultJson = JSON.stringify(`unknown tool: ${call.name}`)
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
  }

  yield { type: 'error', message: `round budget exhausted (${maxRounds})`, rawJson: null }
  yield { type: 'done' }
}

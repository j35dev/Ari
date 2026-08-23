import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import type { AdapterApprovalDecision } from '@ari/providers/driver'
import { newId } from '@ari/shared/ids'
import type { ChatMessage } from './protocols/openai-chat'
import type { AllowRule } from './allowlist'
import { checkPermission, MODE_GUARDED_TOOLS } from './permissions'
import { findTool, type ToolContext } from './tools'

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
   * Resolves mode-gated tool calls through the host approval flow. When
   * absent, mode-gated calls are denied outright instead of silently running.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<AdapterApprovalDecision>
  maxRounds?: number
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
        let execCtx: ToolContext = ctx
        try {
          const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
          if (MODE_GUARDED_TOOLS.has(call.name)) {
            if (alwaysAllowed.has(call.name)) {
              execCtx = { ...ctx, approvedTools: alwaysAllowed }
            } else {
              const decision = checkPermission(permissionMode, call.name)
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

import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import type { AdapterApprovalDecision } from '@ari/providers/driver'
import { newId } from '@ari/shared/ids'
import type { ChatImage, ChatMessage } from './protocols/openai-chat'
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
   * Ari-side session id. Handed to the tool context so per-session tools
   * (todo_write) scope their files instead of sharing one workspace file.
   */
  sessionId?: string
  /**
   * Staged images for this turn, attached to the user message. History
   * messages may carry their own `images` from earlier turns.
   */
  userImages?: ChatImage[]
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
  /**
   * Optional ceiling on model rounds in one turn. Absent — the default — means
   * unbounded: the turn ends when the model stops asking for tools, the way
   * every production coding agent works. A round count is a bad proxy for
   * "stuck", because it cannot tell a long honest task from a loop; that job
   * belongs to {@link MAX_IDENTICAL_ROUNDS} and the user's interrupt. Set this
   * only where a hard bound is genuinely wanted (tests, headless batch runs).
   */
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

/**
 * Consecutive rounds requesting the exact same tool calls before the loop
 * intervenes. The first intervention is a redirect, not a stop: the batch is
 * answered with an explanation instead of being executed, which is usually
 * enough to break the model out. A second run of identical rounds after that
 * ends the turn, so the guard itself cannot loop.
 */
const MAX_IDENTICAL_ROUNDS = 3

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
 * Sorts object keys recursively so two arguments that differ only in key order
 * hash the same. Without this a model can defeat the loop guard by shuffling
 * its own JSON, which costs the user tokens for nothing.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]))
}

/**
 * Canonical identity of one tool call (name + normalized arguments). Two calls
 * with the same identity are asking for exactly the same thing; the near-miss
 * guard keys on this to tell whether a call's result is still fresh.
 */
function callIdentity(call: PendingToolCall): string {
  let args: unknown
  try {
    args = canonicalize(JSON.parse(call.argsJson || '{}'))
  } catch {
    args = call.argsJson
  }
  return JSON.stringify([call.name, args])
}

/**
 * Identity of a round's tool requests. The call list is sorted so a model
 * reordering a parallel batch still reads as the same request, and arguments
 * are canonicalized rather than compared as raw text.
 */
function roundSignature(calls: readonly PendingToolCall[]): string {
  return calls
    .map(callIdentity)
    .sort()
    .join('\u0001')
}

/** Told to the model in place of running a batch it has already run. */
function loopRedirectText(calls: readonly PendingToolCall[]): string {
  const names = [...new Set(calls.map((c) => c.name))].join(', ')
  return (
    `Not run: you have requested this exact call (${names}) with these exact arguments ` +
    'several rounds in a row and the results have not changed. Re-reading the results ' +
    'you already have, take a different action — a different tool, different arguments, ' +
    'or tell the user what is blocking you.'
  )
}

/** Told to the model in place of re-running calls whose results are still in context. */
function staleReadText(calls: readonly PendingToolCall[]): string {
  const names = [...new Set(calls.map((c) => c.name))].join(', ')
  return (
    `Not run: this exact ${names} call already returned this same result earlier in the ` +
    'turn and nothing has changed it since — no writes or commands ran in between, so ' +
    'running it again would repeat what is already on screen. Use the result you have or ' +
    'take a different action.'
  )
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
  const {
    round,
    systemPrompt,
    userPrompt,
    workspacePath,
    maxRounds,
    signal,
  } = options
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
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
  }
  // Tools cleared by an `always-allow` decision run mode-unrestricted for the
  // rest of the loop; single approvals build a per-call context instead.
  const alwaysAllowed = new Set<string>()
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(options.history ?? []),
    {
      role: 'user',
      content: userPrompt,
      ...(options.userImages && options.userImages.length > 0 ? { images: options.userImages } : {}),
    },
  ]
  // The system prompt is rebuilt per turn (its environment facts go stale), so
  // it is never part of the persisted transcript.
  const publishTranscript = (): void => {
    options.onTranscript?.(messages.slice(1).map((m) => ({ ...m })))
  }
  publishTranscript()

  // Loop detection: a model that re-requests the same tool calls round after
  // round is stuck, and letting it run costs the user real tokens. Tracked
  // across rounds, reset the moment anything differs.
  let lastSignature: string | null = null
  let identicalRounds = 0
  let redirected = false
  // Near-miss loop detection: how many times each read-only call has been
  // executed since the last mutating call (or compaction). While that count is
  // unbroken the call's result is byte-identical every run, so re-requesting it
  // a third time adds nothing — even when the repeats are interleaved with other
  // work, which is how a stuck model hides from the back-to-back guard above.
  let freshReadHits = new Map<string, number>()

  for (let current = 0; maxRounds === undefined || current < maxRounds; current++) {
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
        // History changed under the model, so a repeated read may now be asking
        // for content that was summarized away — never flag it as stale.
        freshReadHits = new Map()
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

    const signature = roundSignature(pending)
    identicalRounds = signature === lastSignature ? identicalRounds + 1 : 1
    lastSignature = signature

    // Near-miss: a round made only of read-only calls that have already been
    // executed twice while still fresh is about to re-run byte-identical tools.
    // Unlike identicalRounds (which only sees back-to-back repeats), this also
    // catches a stuck model that interleaves its repeated reads with other work.
    // A mutating call or a compaction clears the map, so a re-read after an edit
    // — the legitimate reason to re-read — is never mistaken for a repeat.
    const allFreshDuplicates =
      pending.length > 0 &&
      pending.every((call) => {
        const tool = toolset.get(call.name)
        const hits = tool?.readOnly === true ? (freshReadHits.get(callIdentity(call)) ?? 0) : 0
        return hits >= 2
      })

    // Answered with an explanation instead of executed, once, when the model
    // is repeating itself; null on every normal round.
    let loopRedirect: string | null = null
    if (allFreshDuplicates || identicalRounds >= MAX_IDENTICAL_ROUNDS) {
      if (redirected) {
        const names = [...new Set(pending.map((p) => p.name))].join(', ')
        yield {
          type: 'error',
          message:
            `the model kept repeating the same tool call (${names}) after being told it ` +
            'was looping, so the turn was stopped',
          rawJson: null,
        }
        yield { type: 'done' }
        return
      }
      redirected = true
      identicalRounds = 0
      if (allFreshDuplicates) {
        // The redirect is not an execution, so drop these calls' freshness to
        // give the model one clean run of MAX before it is stopped again.
        for (const call of pending) freshReadHits.delete(callIdentity(call))
        loopRedirect = staleReadText(pending)
      } else {
        loopRedirect = loopRedirectText(pending)
      }
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
    if (loopRedirect === null) {
      for (const call of pending) {
        const tool = toolset.get(call.name)
        if (tool && isConcurrencySafe(tool)) {
          inFlight.set(call.callId, executeTool(tool, call.argsJson, ctx))
        }
      }
    }

    for (const call of pending) {
      const tool = toolset.get(call.name)
      let resultJson: string
      let isError = false
      const concurrent = inFlight.get(call.callId)
      if (loopRedirect !== null) {
        isError = true
        resultJson = JSON.stringify(loopRedirect)
      } else if (concurrent) {
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

    // Track freshness for the next round's near-miss guard. A read-only call
    // that actually ran is fresh; executing any mutating call invalidates the
    // reads before it, since it may have changed what they saw. A read that
    // shares a round with a mutating call may have raced it, so it is never
    // certified fresh either. Redirected rounds ran nothing, so they leave the
    // map untouched.
    if (loopRedirect === null) {
      const mutated = pending.some((call) => toolset.get(call.name)?.readOnly !== true)
      if (mutated) {
        freshReadHits.clear()
      } else {
        for (const call of pending) {
          const identity = callIdentity(call)
          freshReadHits.set(identity, (freshReadHits.get(identity) ?? 0) + 1)
        }
      }
    }
    publishTranscript()
  }

  // Only reachable when the caller set an explicit ceiling: the default loop
  // has none and leaves through the model finishing, the repetition guard, or
  // the user's interrupt.
  yield {
    type: 'error',
    message:
      `the turn hit its ${String(maxRounds)}-round step limit before the model finished; ` +
      'the work so far is kept — send another message to continue from here',
    rawJson: null,
  }
  yield { type: 'done' }
}

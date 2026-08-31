import { z } from 'zod'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { formatUnknownError } from '@ari/shared/result'

/**
 * Structural types for the subset of the Agent Client Protocol (ACP) v1
 * Ari consumes, plus the pure mapper from `session/update` notifications to
 * normalized AgentEvents. Parsing is deliberately lenient (matching the
 * other drivers): unknown variants are ignored, malformed fields degrade to
 * empty values — an agent sending slightly-off shapes must never crash the
 * host. Spec: https://agentclientprotocol.com
 */

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export const AUTH_REQUIRED_ERROR = -32000

/** Content block as carried in chunks and tool results. */
export interface AcpContentBlock {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  resource?: { uri?: string; text?: string }
}

/** One tool-call content item: content blocks, diffs, or terminals. */
export interface AcpToolCallContent {
  type?: string
  content?: { type?: string; text?: string } | AcpContentBlock[]
  path?: string
  oldText?: string | null
  newText?: string | null
}

const acpContentBlockSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
  uri: z.string().optional(),
  resource: z.object({ uri: z.string().optional(), text: z.string().optional() }).optional(),
}) satisfies z.ZodType<AcpContentBlock>

// Fail-soft on purpose: a malformed tool item drops out of the projection
// instead of corrupting the transcript or crashing the fold.
export const acpToolCallContentSchema = z.object({
  type: z.string().optional(),
  content: z
    .union([acpContentBlockSchema, z.array(acpContentBlockSchema)])
    .optional(),
  path: z.string().optional(),
  oldText: z.string().nullable().optional(),
  newText: z.string().nullable().optional(),
}) satisfies z.ZodType<AcpToolCallContent>

/** Tool-call payloads ride the same flat shape as every other update, but
 * their `content` carries tool-call items rather than plain content blocks. */
export type AcpToolCallUpdate = Omit<AcpSessionUpdate, 'content'> & {
  content?: AcpContentBlock | AcpContentBlock[] | AcpToolCallContent[]
}

export interface AcpConfigOptionValue {
  value?: string
  name?: string
  description?: string
}

/** Session configuration option (`select` flavor); booleans are ignored by Ari. */
export interface AcpConfigOption {
  id?: string
  name?: string
  category?: string
  type?: string
  currentValue?: string | boolean
  options?: AcpConfigOptionValue[]
}

export interface AcpUsageCost {
  amount?: number
  currency?: string
}

/**
 * Flat, defensive shape of a `session/update` payload. Every variant shares
 * one interface so unknown `sessionUpdate` discriminators degrade to no-ops
 * instead of breaking parsing (mirrors the NativeLine style of the other
 * driver mappers).
 */
export interface AcpSessionUpdate {
  sessionUpdate?: string
  content?: AcpContentBlock | AcpContentBlock[]
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  locations?: { path: string; line?: number }[]
  configOptions?: AcpConfigOption[]
  currentModeId?: string
  used?: number
  size?: number
  cost?: AcpUsageCost | null
}

export interface AcpSessionNotification {
  sessionId?: string
  update?: AcpSessionUpdate
}

export interface AcpPermissionOption {
  optionId?: string
  name?: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** Server→client permission request params. */
export interface AcpRequestPermission {
  sessionId?: string
  toolCall?: AcpToolCallUpdate
  options?: AcpPermissionOption[]
}

export interface AcpNewSessionResult {
  sessionId?: string
  configOptions?: AcpConfigOption[] | null
  modes?: {
    currentModeId?: string
    availableModes?: { id?: string; name?: string }[]
  } | null
}

/**
 * One entry of `initialize.authMethods`. `type: 'terminal'` methods are run by
 * the client, not the agent; the `terminal-auth` `_meta` block spells out the
 * exact argv so a client without ACP's `terminal/*` methods can still launch
 * the login in a pty of its own.
 */
export interface AcpAuthMethod {
  id?: string
  name?: string
  description?: string
  type?: string
  _meta?: {
    'terminal-auth'?: {
      command?: string
      args?: string[]
      label?: string
    }
  }
}

export interface AcpInitializeResult {
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: Record<string, unknown> }
  authMethods?: AcpAuthMethod[]
}

/**
 * A login Ari can actually run: an auth method that carried a complete
 * `terminal-auth` argv. Ari never handles the credentials themselves — the
 * agent's own CLI performs the login and writes its own credential store.
 */
export interface AcpTerminalLogin {
  /** `authMethods[].id`, e.g. `claude-ai-login`. */
  methodId: string
  /** Button label, e.g. "Claude Subscription". */
  name: string
  /** One-line explanation from the agent, e.g. "Use Claude subscription". */
  description: string
  command: string
  args: string[]
}

/**
 * Projects `initialize.authMethods` onto the subset Ari can launch. Methods
 * without a runnable `terminal-auth` argv are dropped: offering a button that
 * cannot do anything is worse than offering none.
 */
export function terminalLoginsFrom(result: AcpInitializeResult | null | undefined): AcpTerminalLogin[] {
  const logins: AcpTerminalLogin[] = []
  for (const method of result?.authMethods ?? []) {
    const terminal = method._meta?.['terminal-auth']
    const command = terminal?.command
    if (typeof method.id !== 'string' || method.id.length === 0) continue
    if (typeof command !== 'string' || command.length === 0) continue
    const args = (terminal?.args ?? []).filter((arg): arg is string => typeof arg === 'string')
    logins.push({
      methodId: method.id,
      name:
        typeof method.name === 'string' && method.name.trim().length > 0
          ? method.name.trim()
          : (terminal?.label ?? method.id),
      description: typeof method.description === 'string' ? method.description.trim() : '',
      command,
      args,
    })
  }
  return logins
}

function asBlocks(content: AcpContentBlock | AcpContentBlock[] | undefined): AcpContentBlock[] {
  if (content === undefined) return []
  return Array.isArray(content) ? content : [content]
}

function textOf(blocks: AcpContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Best-effort JSON for tool result payloads: rawOutput when present,
 * otherwise a compact projection of the content list (texts + diffs).
 */
function resultJsonOf(update: AcpToolCallUpdate): string {
  if (update.rawOutput !== undefined) return JSON.stringify(update.rawOutput)
  const parts: Record<string, unknown>[] = []
  const items = acpToolCallContentSchema.array().catch([]).parse(update.content ?? [])
  for (const item of items) {
    if (item.type === 'diff') {
      parts.push({ diff: { path: item.path ?? '', oldText: item.oldText ?? null, newText: item.newText ?? null } })
      continue
    }
    for (const block of asBlocks(item.content)) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text })
    }
  }
  return JSON.stringify(parts.length === 1 ? parts[0] : parts)
}

/**
 * Folds `session/update` notification payloads into normalized events.
 * Tool calls are deduped per id across create/update pairs so each Ari tool
 * part starts once and completes once.
 */
export class AcpUpdateFolder {
  readonly #started = new Set<string>()

  fold(notification: AcpSessionNotification): AgentEvent[] {
    const update = notification.update
    if (update === undefined || typeof update.sessionUpdate !== 'string') return []
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return chunkToDeltas(textOf(asBlocks(update.content)), 'text-delta')
      case 'agent_thought_chunk':
        return chunkToDeltas(textOf(asBlocks(update.content)), 'thinking-delta')
      case 'tool_call': {
        const callId = typeof update.toolCallId === 'string' ? update.toolCallId : null
        if (callId === null) return []
        this.#started.add(callId)
        const events: AgentEvent[] = [toStarted(callId, update)]
        if (update.status === 'completed' || update.status === 'failed') {
          events.push(toCompleted(callId, update))
        }
        return events
      }
      case 'tool_call_update': {
        const callId = typeof update.toolCallId === 'string' ? update.toolCallId : null
        if (callId === null) return []
        const terminal = update.status === 'completed' || update.status === 'failed'
        if (!terminal) return []
        // Some agents finalize without a prior create — synthesize the start.
        const started: AgentEvent[] = this.#started.has(callId)
          ? []
          : [toStarted(callId, update)]
        this.#started.add(callId)
        return [...started, toCompleted(callId, update)]
      }
      case 'error': {
        // Agent-reported fatal errors ride session/update like everything
        // else; swallowing them made failures look like silent stalls.
        const text = textOf(asBlocks(update.content))
        return [
          {
            type: 'error',
            message:
              text.length > 0 ? text : `${notification.sessionId ?? 'agent'} reported an unspecified error`,
            rawJson: JSON.stringify(update),
          },
        ]
      }
      case 'usage_update': {
        const used = typeof update.used === 'number' && update.used >= 0 ? Math.floor(update.used) : 0
        const costUsd = update.cost?.currency === 'USD' && typeof update.cost.amount === 'number'
          ? update.cost.amount
          : null
        return [{ type: 'usage', inputTokens: used, outputTokens: 0, costUsd }]
      }
      default:
        // user_message_chunk / plan / mode / config / commands updates have
        // no transcript surface yet (plan needs a dedicated event + UI).
        return []
    }
  }
}

function chunkToDeltas(text: string, kind: 'text-delta' | 'thinking-delta'): AgentEvent[] {
  return text.length > 0 ? [{ type: kind, text }] : []
}

function toStarted(callId: string, update: AcpToolCallUpdate): AgentEvent {
  const rawName =
    update.rawInput !== null && typeof update.rawInput === 'object' && update.rawInput !== null
      ? (update.rawInput as Record<string, unknown>)['name']
      : undefined
  const name =
    typeof rawName === 'string' && rawName.length > 0
      ? rawName
      : typeof update.kind === 'string' && update.kind.length > 0
        ? update.kind
        : 'tool'
  return {
    type: 'tool-started',
    callId,
    name,
    argsJson: JSON.stringify({
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
    }),
  }
}

function toCompleted(callId: string, update: AcpToolCallUpdate): AgentEvent {
  return {
    type: 'tool-completed',
    callId,
    resultJson: resultJsonOf(update),
    isError: update.status === 'failed',
  }
}

/** Maps a JSON-RPC stopReason onto the closing AgentEvents of a turn. */
export function stopReasonEvents(stopReason: string): AgentEvent[] {
  switch (stopReason) {
    case 'end_turn':
    case 'cancelled':
    case 'max_turn_requests':
      return [{ type: 'done' }]
    case 'refusal':
      return [
        { type: 'error', message: 'The agent refused to continue this prompt.', rawJson: null },
        { type: 'done' },
      ]
    case 'max_tokens':
      return [
        { type: 'error', message: 'The turn hit the model token limit.', rawJson: null },
        { type: 'done' },
      ]
    default:
      return [{ type: 'done' }]
  }
}

/** Formats any thrown value from connection setup into a legible message. */
export function describeAcpFailure(error: unknown): string {
  return formatUnknownError(error)
}

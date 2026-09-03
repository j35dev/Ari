import type { AgentEvent } from '@ari/contracts/agent-event'
import type {
  AdapterApprovalDecision,
  AdapterSession,
  Driver,
  ProviderAdapter,
} from '@ari/providers/driver'
import { runAgentLoop, type ApprovalRequest } from './agent-loop'
import {
  streamChatCompletion,
  type ChatImage,
  type ChatMessage,
} from './protocols/openai-chat'
import {
  streamChatAnthropic,
  type AnthropicChatRequest,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicToolResultBlock,
} from './protocols/anthropic-messages'
import { streamChatOllama, type OllamaChatRequest } from './protocols/ollama'
import {
  CONTEXT_WINDOW_CHARS,
  KEEP_RECENT_RATIO,
  needsCompaction,
  serializeForSummary,
  splitForCompaction,
  summaryMessage,
  SUMMARY_INSTRUCTIONS,
  trimMessages,
} from './context-manager'
import type { AllowRule } from './allowlist'
import type { Endpoint, EndpointStore } from './endpoints'
import type { McpServerConfig } from './mcp-servers'
import { McpConnection } from './mcp'
import { mountMcpTools, type MountedMcpServer } from './mcp-tools'
import { BUILT_IN_TOOLS, type Tool } from './tools'
import { loadImageData, missingImagesNote } from '@ari/providers/attachments'
import { buildSystemPrompt } from './system-prompt'
import {
  MemoryConversationStore,
  type ConversationStore,
} from './conversation-store'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ari-core:driver')

/** Protocol client overrides; tests inject fakes, production uses the real streamers. */
export interface AriCoreDriverClients {
  openai?: typeof streamChatCompletion
  anthropic?: typeof streamChatAnthropic
  ollama?: typeof streamChatOllama
}

export interface AriCoreDriverOptions {
  clients?: AriCoreDriverClients
  /** Char budget handed to the context manager before each round. */
  contextCharLimit?: number
  /**
   * Permission rules (glob per tool) intersected with the session's
   * permission mode inside the agent loop. Not yet wired from settings;
   * mode enforcement works without it.
   */
  allowlist?: AllowRule[]
  /**
   * MCP servers mounted for every turn created by this driver. Disabled
   * entries are skipped; a server that fails to start is logged and
   * omitted so the turn always runs.
   */
  mcpServers?: McpServerConfig[]
  /** Connection seam for tests; production connects over real stdio. */
  mcpConnect?: (server: McpServerConfig) => Promise<McpConnection>
  /**
   * Conversation memory across turns of one session. Defaults to an
   * in-process store; the desktop layer passes a disk-backed one so a
   * session's history survives a restart.
   */
  conversations?: ConversationStore
  /**
   * Summarize older history instead of dropping it once the context budget is
   * mostly used. Costs one extra model call when it triggers; disable to keep
   * the plain trimming behaviour. Default true.
   */
  compaction?: boolean
}

interface RenderedTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: ChatImage[]
}

/**
 * Renders internal messages as plain text turns for flavors without a
 * native tool-role pipeline: tool results become user text, assistant tool
 * calls are serialized inline, consecutive same-role turns merge.
 * Attached images ride along on their turn (merged like content).
 */
function renderAsTextTurns(messages: ChatMessage[]): RenderedTurn[] {
  const out: RenderedTurn[] = []
  const push = (role: RenderedTurn['role'], content: string, images?: ChatImage[]) => {
    const last = out.at(-1)
    if (last && last.role === role) {
      last.content += `\n\n${content}`
      if (images && images.length > 0) last.images = [...(last.images ?? []), ...images]
      return
    }
    out.push({ role, content, ...(images && images.length > 0 ? { images: [...images] } : {}) })
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.toolCallId ? ` ${message.toolCallId}` : ''
      push('user', `[tool result${id}]\n${message.content}`)
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls.map((c) => `[tool call ${c.name}] ${c.argsJson}`).join('\n')
      push('assistant', message.content ? `${message.content}\n${calls}` : calls)
    } else {
      push(message.role, message.content, message.images)
    }
  }
  return out
}

/** Advertised tool shape used across protocol flavors. */
interface AdvertisedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Parses a tool call's JSON args; malformed args degrade to `{}`. */
function parseToolInput(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson) as unknown
  } catch {
    return {}
  }
}

/**
 * Serializes internal messages as native Anthropic turns. An assistant tool
 * call becomes `tool_use` content blocks and its results become `tool_result`
 * blocks in the following user turn (Anthropic requires each `tool_use` to be
 * answered by a `tool_result` in the very next user message). Consecutive
 * plain user turns merge: compaction inserts a summary user message directly
 * before the next prompt, and Anthropic rejects adjacent user turns.
 */
function anthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  let results: AnthropicToolResultBlock[] = []
  /**
   * Appends one user turn's blocks, merging into the previous user turn when
   * there already is one — adjacent user turns are invalid on the wire. The
   * merge always appends: replacing what the previous turn holds would strip
   * the `tool_result`s answering the assistant's `tool_use`, or a prior turn's
   * images, and the request would be rejected.
   */
  const appendUser = (blocks: AnthropicContentBlock[]): void => {
    if (blocks.length === 0) return
    const last = out.at(-1)
    if (last?.role !== 'user') {
      // A turn carrying nothing but text stays a plain string; blocks are only
      // needed once images or tool results share the turn.
      const only = blocks.length === 1 ? blocks[0] : undefined
      out.push({ role: 'user', content: only?.type === 'text' ? only.text : blocks })
      return
    }
    const prior: AnthropicContentBlock[] =
      typeof last.content === 'string'
        ? last.content.length > 0
          ? [{ type: 'text', text: last.content }]
          : []
        : last.content
    last.content = [...prior, ...blocks]
  }
  const flushResults = (): void => {
    if (results.length === 0) return
    appendUser(results)
    results = []
  }
  const pushUser = (content: string, images?: ChatImage[]): void => {
    const blocks: AnthropicContentBlock[] = []
    if (content.length > 0) blocks.push({ type: 'text', text: content })
    for (const image of images ?? []) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 },
      })
    }
    appendUser(blocks)
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      results.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      })
      continue
    }
    if (message.role === 'assistant') {
      flushResults()
      const blocks: AnthropicContentBlock[] = []
      if (message.content.length > 0) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.argsJson) })
      }
      // A turn with neither text nor tool calls has no valid wire form — the
      // API rejects empty content — and carries nothing the model needs, so it
      // is dropped rather than sent. Any user turn that follows merges into the
      // one before it, so dropping this never leaves two users adjacent.
      if (blocks.length === 0) continue
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    // user
    flushResults()
    pushUser(message.content, message.images)
  }
  flushResults()
  return out
}

function anthropicRequest(
  endpoint: Endpoint,
  model: string,
  apiKey: string | null,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  effort: string | null,
  advertised: AdvertisedTool[],
): AnthropicChatRequest {
  let system = ''
  const rest: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      system += system.length > 0 ? `\n\n${message.content}` : message.content
    } else {
      rest.push(message)
    }
  }
  return {
    baseUrl: endpoint.baseUrl,
    apiKey,
    model,
    ...(system.length > 0 ? { system } : {}),
    messages: anthropicMessages(rest),
    tools: advertised.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    headers: endpoint.headers,
    signal,
    reasoningEffort: effort,
    // Every round of a turn resends the same system prompt and tool schemas;
    // caching that prefix is the cheapest latency win available to a harness
    // that runs many rounds. Any endpoint on this flavor speaks the Messages
    // API, which has carried `cache_control` since Claude 3.
    cache: true,
  }
}

function ollamaRequest(
  endpoint: Endpoint,
  model: string,
  apiKey: string | null,
  messages: ChatMessage[],
  signal?: AbortSignal,
): OllamaChatRequest {
  return {
    baseUrl: endpoint.baseUrl,
    apiKey,
    model,
    messages: renderAsTextTurns(messages),
    headers: endpoint.headers,
    signal,
  }
}

/**
 * Driver for user-configured model endpoints. `modelId` carries the
 * endpoint id; the endpoint store supplies base URL/key/model/flavor.
 * Requests route through the protocol client matching `endpoint.flavor`
 * (openai-chat | anthropic-messages | ollama), and the context manager
 * trims history before every round once it grows past the char budget.
 *
 * The session's permission mode is enforced inside the agent loop: mode-gated
 * tool calls emit `approval-requested` and park until `respondApproval`
 * answers them (or the turn aborts, which denies them).
 *
 * Enabled MCP servers are mounted per turn: each one spawns over stdio,
 * lists its tools as `mcp_<server>_<tool>`, and joins the loop's toolset.
 * Failures fail soft — a dead server is logged and omitted for the turn.
 *
 * Conversation memory is the driver's own concern: CLI drivers resume a
 * provider-side thread through `resumeOf`, but Ari Core has none, so it
 * replays the session's stored transcript ahead of each new prompt.
 */
export class AriCoreDriver implements Driver {
  readonly kind = 'ari-core' as const

  readonly #endpoints: EndpointStore
  readonly #clients: AriCoreDriverClients
  readonly #contextCharLimit: number
  readonly #allowlist: AllowRule[] | undefined
  readonly #mcpServers: McpServerConfig[]
  readonly #mcpConnectOverride?: (server: McpServerConfig) => Promise<McpConnection>
  readonly #conversations: ConversationStore
  readonly #compaction: boolean

  constructor(endpoints: EndpointStore, options: AriCoreDriverOptions = {}) {
    this.#endpoints = endpoints
    this.#clients = options.clients ?? {}
    this.#contextCharLimit = options.contextCharLimit ?? CONTEXT_WINDOW_CHARS
    this.#allowlist = options.allowlist
    this.#mcpServers = options.mcpServers ?? []
    this.#mcpConnectOverride = options.mcpConnect
    this.#conversations = options.conversations ?? new MemoryConversationStore()
    this.#compaction = options.compaction ?? true
  }

  create(session: AdapterSession): Promise<ProviderAdapter> {
    // The UI namespaces endpoint models as `ep:<endpointId>:<model>` in the
    // shared selector (legacy `ep:<endpointId>` falls back to the endpoint's
    // default model); the driver owns stripping that prefix so every caller
    // is safe. Model ids may contain colons (e.g. `llama3.1:8b`), so the
    // split is on the first colon after the endpoint id.
    const raw = session.modelId ?? ''
    let endpointId = raw.startsWith('ep:') ? raw.slice(3) : raw
    let modelOverride: string | null = null
    if (raw.startsWith('ep:')) {
      const rest = raw.slice(3)
      const sep = rest.indexOf(':')
      if (sep !== -1) {
        endpointId = rest.slice(0, sep)
        modelOverride = rest.slice(sep + 1)
      }
    }
    const apiKey = this.#endpoints.apiKeyFor(endpointId)
    const endpoint = this.#endpoints.list().find((e) => e.id === endpointId)
    const clients = this.#clients
    const contextCharLimit = this.#contextCharLimit
    const allowlist = this.#allowlist
    const conversations = this.#conversations
    const compaction = this.#compaction
    const mcpServers = this.#mcpServers.filter((s) => !s.disabled)
    const mcpConnect =
      this.#mcpConnectOverride ??
      ((server: McpServerConfig) =>
        McpConnection.connect(server, { cwd: session.workspacePath }))

    const abort = new AbortController()

    // Mode-gated calls park here until the host answers via respondApproval.
    const pendingApprovals = new Map<string, (decision: AdapterApprovalDecision) => void>()
    const pendingInputs = new Map<string, (value: string) => void>()
    // Live MCP connections for this turn; disposed with the adapter or at
    // the end of the loop, whichever comes first (dispose is idempotent).
    const mcpConnections: McpConnection[] = []
    const disposeMcpConnections = (): Promise<void> => {
      const connections = [...mcpConnections]
      mcpConnections.length = 0
      return Promise.allSettled(connections.map((c) => c.dispose())).then(() => {})
    }
    abort.signal.addEventListener(
      'abort',
      () => {
        for (const [id, resolve] of pendingApprovals) {
          pendingApprovals.delete(id)
          resolve('deny')
        }
        for (const [id, resolve] of pendingInputs) {
          pendingInputs.delete(id)
          resolve('')
        }
      },
      { once: true },
    )
    const requestApproval = (request: ApprovalRequest): Promise<AdapterApprovalDecision> => {
      return new Promise((resolve) => {
        pendingApprovals.set(request.approvalId, resolve)
      })
    }
    const requestInput = (inputId: string): Promise<string> => {
      return new Promise((resolve) => {
        pendingInputs.set(inputId, resolve)
      })
    }

    async function* start(): AsyncGenerator<AgentEvent> {
      if (!endpoint) {
        yield {
          type: 'error',
          message: `no ari-core endpoint configured (${endpointId || 'none'})`,
          rawJson: null,
        }
        yield { type: 'done' }
        return
      }

      const model = modelOverride ?? endpoint.model

      // Staged images become multimodal parts on the user message; unreadable
      // ones are named in text instead of dropped.
      const { loaded, missing } = await loadImageData(
        (session.attachments ?? []).map((a) => ({ ...a })),
      )
      const userPrompt = session.prompt + missingImagesNote(missing)
      const userImages: ChatImage[] = loaded.map((img) => ({
        dataBase64: img.dataBase64,
        mimeType: img.mimeType,
      }))

      // Mount enabled MCP servers for this turn: connect (fail-soft), list
      // tools, and hand the merged toolset to the loop. A dead or slow
      // server is logged and omitted; the turn always runs. The advertised
      // schemas go on the OpenAI-compat request so the model emits native
      // tool_calls instead of dumping markup into the transcript.
      let extraTools: Tool[] = []
      if (mcpServers.length > 0) {
        const mounted: MountedMcpServer[] = []
        for (const server of mcpServers) {
          try {
            const connection = await mcpConnect(server)
            mcpConnections.push(connection)
            mounted.push({ name: server.name, connection })
          } catch (error) {
            log.warn('mcp server unavailable; omitting', {
              server: server.name,
              error: String(error),
            })
          }
        }
        extraTools = await mountMcpTools(mounted)
      }
      const advertised = [...BUILT_IN_TOOLS, ...extraTools].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))

      const effort = session.effort ?? null
      const round = (messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<AgentEvent> => {
        // Context guardrail runs before every round; a no-op while small. It is
        // the floor under compaction, not a replacement for it: trimming drops
        // history, compaction summarizes it first.
        const effective = trimMessages(messages, contextCharLimit)
        switch (endpoint.flavor) {
          case 'anthropic-messages':
            return (clients.anthropic ?? streamChatAnthropic)(
              anthropicRequest(endpoint, model, apiKey, effective, signal, effort, advertised),
            )
          case 'ollama':
            return (clients.ollama ?? streamChatOllama)(
              ollamaRequest(endpoint, model, apiKey, effective, signal),
            )
          case 'openai-chat':
            return (clients.openai ?? streamChatCompletion)({
              baseUrl: endpoint.baseUrl,
              apiKey,
              model,
              messages: effective,
              tools: advertised,
              headers: endpoint.headers,
              signal,
              reasoningEffort: effort,
            })
        }
      }

      // Replay this session's earlier turns so the model keeps its memory;
      // the stored transcript is trimmed to the same budget as a request so a
      // long session cannot grow it without bound.
      const history = trimMessages(await conversations.load(session.sessionId), contextCharLimit)
      let latest: ChatMessage[] = history
      const persist = (): Promise<void> =>
        conversations
          .save(session.sessionId, trimMessages(latest, contextCharLimit))
          .catch((error: unknown) => {
            // Losing memory is worse than a noisy log, but never fatal to a turn.
            log.warn('failed to persist ari-core conversation', {
              sessionId: session.sessionId,
              error: String(error),
            })
          })

      /**
       * Summarizes an older span through the session's own model. Usage from
       * this call is not folded into the turn's totals, so cost under-reports
       * slightly when a session compacts.
       */
      const summarize = async (older: ChatMessage[]): Promise<string> => {
        let text = ''
        for await (const event of round(
          [
            { role: 'system', content: SUMMARY_INSTRUCTIONS },
            { role: 'user', content: serializeForSummary(older) },
          ],
          abort.signal,
        )) {
          if (event.type === 'text-delta') text += event.text
        }
        return text.trim()
      }

      /**
       * Replaces the summarizable span with one summary message, keeping the
       * newest turns verbatim. Failure falls through to plain trimming: a
       * degraded context is better than a failed turn.
       */
      const compact = async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
        if (!needsCompaction(messages, contextCharLimit)) return messages
        const { systems, older, recent } = splitForCompaction(
          messages,
          Math.max(1, Math.floor(contextCharLimit * KEEP_RECENT_RATIO)),
        )
        if (older.length === 0) return messages
        try {
          const summary = await summarize(older)
          if (summary.length === 0) return messages
          log.info('compacted ari-core context', {
            sessionId: session.sessionId,
            summarized: older.length,
            kept: recent.length,
          })
          return [...systems, summaryMessage(summary), ...recent]
        } catch (error) {
          log.warn('compaction failed; falling back to trimming', {
            sessionId: session.sessionId,
            error: String(error),
          })
          return messages
        }
      }

      try {
        yield* runAgentLoop({
          round,
          systemPrompt: await buildSystemPrompt({ workspacePath: session.workspacePath }),
          userPrompt,
          ...(userImages.length > 0 ? { userImages } : {}),
          workspacePath: session.workspacePath,
          sessionId: session.sessionId,
          permissionMode: session.permissionMode,
          history,
          onTranscript: (messages) => {
            latest = messages
          },
          ...(compaction ? { compact } : {}),
          requestApproval,
          requestInput,
          ...(allowlist ? { allowlist } : {}),
          ...(extraTools.length > 0 ? { extraTools } : {}),
          signal: abort.signal,
        })
      } finally {
        // Persist whatever the turn produced, including a partial transcript
        // after an interrupt — the next turn should see what already happened.
        await persist()
        await disposeMcpConnections()
      }
    }

    const iterator = start()[Symbol.asyncIterator]()

    return Promise.resolve({
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      respondApproval: (approvalId, decision) => {
        const resolve = pendingApprovals.get(approvalId)
        if (!resolve) return
        pendingApprovals.delete(approvalId)
        resolve(decision)
      },
      respondInput: (inputId, value) => {
        const resolve = pendingInputs.get(inputId)
        if (!resolve) return
        pendingInputs.delete(inputId)
        resolve(value)
      },
      interrupt: () => abort.abort(),
      dispose: () => {
        abort.abort()
        void disposeMcpConnections()
        return Promise.resolve()
      },
    })
  }
}

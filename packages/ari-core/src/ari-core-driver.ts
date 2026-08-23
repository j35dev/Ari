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
  type ChatMessage,
} from './protocols/openai-chat'
import {
  streamChatAnthropic,
  type AnthropicChatRequest,
} from './protocols/anthropic-messages'
import { streamChatOllama, type OllamaChatRequest } from './protocols/ollama'
import { CONTEXT_WINDOW_CHARS, trimMessages } from './context-manager'
import type { AllowRule } from './allowlist'
import type { Endpoint, EndpointStore } from './endpoints'

const SYSTEM_PROMPT = [
  'You are Ari Core, a coding agent embedded in the Ari desktop app.',
  'You work inside the user workspace and have tools for reading, writing,',
  'editing, searching files and running shell commands.',
  'Prefer precise edits over rewrites; verify with the shell when possible;',
  'keep answers tight.',
].join(' ')

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
}

interface RenderedTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Renders internal messages as plain text turns for flavors without a
 * native tool-role pipeline: tool results become user text, assistant tool
 * calls are serialized inline, consecutive same-role turns merge.
 */
function renderAsTextTurns(messages: ChatMessage[]): RenderedTurn[] {
  const out: RenderedTurn[] = []
  const push = (role: RenderedTurn['role'], content: string) => {
    const last = out.at(-1)
    if (last && last.role === role) {
      last.content += `\n\n${content}`
      return
    }
    out.push({ role, content })
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.toolCallId ? ` ${message.toolCallId}` : ''
      push('user', `[tool result${id}]\n${message.content}`)
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls.map((c) => `[tool call ${c.name}] ${c.argsJson}`).join('\n')
      push('assistant', message.content ? `${message.content}\n${calls}` : calls)
    } else {
      push(message.role, message.content)
    }
  }
  return out
}

function anthropicRequest(
  endpoint: Endpoint,
  apiKey: string | null,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AnthropicChatRequest {
  const turns = renderAsTextTurns(messages)
  const system = turns
    .filter((turn): turn is RenderedTurn & { role: 'system' } => turn.role === 'system')
    .map((turn) => turn.content)
    .join('\n\n')
  const rest = turns.filter((turn) => turn.role !== 'system')
  return {
    baseUrl: endpoint.baseUrl,
    apiKey,
    model: endpoint.model,
    ...(system ? { system } : {}),
    messages: rest.map((turn) =>
      turn.role === 'assistant'
        ? { role: 'assistant', content: turn.content }
        : { role: 'user', content: turn.content },
    ),
    headers: endpoint.headers,
    signal,
  }
}

function ollamaRequest(
  endpoint: Endpoint,
  apiKey: string | null,
  messages: ChatMessage[],
  signal?: AbortSignal,
): OllamaChatRequest {
  return {
    baseUrl: endpoint.baseUrl,
    apiKey,
    model: endpoint.model,
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
 */
export class AriCoreDriver implements Driver {
  readonly kind = 'ari-core' as const

  readonly #endpoints: EndpointStore
  readonly #clients: AriCoreDriverClients
  readonly #contextCharLimit: number
  readonly #allowlist: AllowRule[] | undefined

  constructor(endpoints: EndpointStore, options: AriCoreDriverOptions = {}) {
    this.#endpoints = endpoints
    this.#clients = options.clients ?? {}
    this.#contextCharLimit = options.contextCharLimit ?? CONTEXT_WINDOW_CHARS
    this.#allowlist = options.allowlist
  }

  create(session: AdapterSession): Promise<ProviderAdapter> {
    // The UI namespaces endpoint models as `ep:<id>` in the shared selector;
    // the driver owns stripping that prefix so every caller is safe.
    const raw = session.modelId ?? ''
    const endpointId = raw.startsWith('ep:') ? raw.slice(3) : raw
    const apiKey = this.#endpoints.apiKeyFor(endpointId)
    const endpoint = this.#endpoints.list().find((e) => e.id === endpointId)
    const clients = this.#clients
    const contextCharLimit = this.#contextCharLimit
    const allowlist = this.#allowlist

    const abort = new AbortController()

    // Mode-gated calls park here until the host answers via respondApproval.
    const pendingApprovals = new Map<string, (decision: AdapterApprovalDecision) => void>()
    abort.signal.addEventListener(
      'abort',
      () => {
        for (const [id, resolve] of pendingApprovals) {
          pendingApprovals.delete(id)
          resolve('deny')
        }
      },
      { once: true },
    )
    const requestApproval = (request: ApprovalRequest): Promise<AdapterApprovalDecision> => {
      return new Promise((resolve) => {
        pendingApprovals.set(request.approvalId, resolve)
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

      const round = (messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<AgentEvent> => {
        // Context guardrail runs before every round; a no-op while small.
        const effective = trimMessages(messages, contextCharLimit)
        switch (endpoint.flavor) {
          case 'anthropic-messages':
            return (clients.anthropic ?? streamChatAnthropic)(
              anthropicRequest(endpoint, apiKey, effective, signal),
            )
          case 'ollama':
            return (clients.ollama ?? streamChatOllama)(
              ollamaRequest(endpoint, apiKey, effective, signal),
            )
          case 'openai-chat':
            return (clients.openai ?? streamChatCompletion)({
              baseUrl: endpoint.baseUrl,
              apiKey,
              model: endpoint.model,
              messages: effective,
              headers: endpoint.headers,
              signal,
            })
        }
      }

      yield* runAgentLoop({
        round,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: session.prompt,
        workspacePath: session.workspacePath,
        permissionMode: session.permissionMode,
        requestApproval,
        ...(allowlist ? { allowlist } : {}),
        signal: abort.signal,
      })
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
      interrupt: () => abort.abort(),
      dispose: () => {
        abort.abort()
        return Promise.resolve()
      },
    })
  }
}

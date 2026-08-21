import type { AgentEvent } from '@ari/contracts/agent-event'
import type { AdapterSession, Driver, ProviderAdapter } from '@ari/providers/driver'
import { runAgentLoop } from './agent-loop'
import { streamChatCompletion, type ChatMessage } from './protocols/openai-chat'
import type { EndpointStore } from './endpoints'

const SYSTEM_PROMPT = [
  'You are Ari Core, a coding agent embedded in the Ari desktop app.',
  'You work inside the user workspace and have tools for reading, writing,',
  'editing, searching files and running shell commands.',
  'Prefer precise edits over rewrites; verify with the shell when possible;',
  'keep answers tight.',
].join(' ')

/**
 * Driver for user-configured OpenAI-compatible endpoints. `modelId` carries
 * the endpoint id; the endpoint store supplies base URL/key/model.
 */
export class AriCoreDriver implements Driver {
  readonly kind = 'ari-core' as const

  constructor(private readonly endpoints: EndpointStore) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const endpointId = session.modelId ?? ''
    const apiKey = this.endpoints.apiKeyFor(endpointId)
    const endpoint = this.endpoints
      .list()
      .find((e) => e.id === endpointId && e.flavor === 'openai-chat')

    const abort = new AbortController()

    async function* start(): AsyncGenerator<AgentEvent> {
      if (!endpoint) {
        yield {
          type: 'error',
          message: `no openai-chat endpoint configured (${endpointId || 'none'})`,
          rawJson: null,
        }
        yield { type: 'done' }
        return
      }

      const round = (messages: ChatMessage[], signal?: AbortSignal) =>
        streamChatCompletion({
          baseUrl: endpoint.baseUrl,
          apiKey,
          model: endpoint.model,
          messages,
          headers: endpoint.headers,
          signal,
        })

      yield* runAgentLoop({
        round,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: session.prompt,
        workspacePath: session.workspacePath,
        signal: abort.signal,
      })
    }

    const iterator = start()[Symbol.asyncIterator]()

    return Promise.resolve({
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => abort.abort(),
      dispose: () => {
        abort.abort()
        return Promise.resolve()
      },
    })
  }
}

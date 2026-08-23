import type { McpConnection, McpToolInfo } from './mcp'
import type { Tool } from './tools'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ari-core:mcp-tools')

/**
 * Maps MCP server tools onto the Ari Core Tool shape so the agent loop can
 * call them like any built-in.
 */

/**
 * Normalizes one name segment into a model-safe identifier chunk
 * (`[a-z0-9_]`); empty input degrades to a placeholder instead of
 * collapsing the whole tool name.
 */
export function sanitizeMcpSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'x'
}

/** Prefixed, collision-resistant Ari-side name: `mcp_<server>_<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeMcpSegment(serverName)}_${sanitizeMcpSegment(toolName)}`
}

export interface MountedMcpServer {
  /** Display name of the server; sanitized into the tool-name prefix. */
  name: string
  connection: McpConnection
}

/**
 * Lists tools from every mounted server and adapts them onto the loop's
 * Tool shape. A server whose listing fails is skipped with a warning — one
 * dead MCP server never takes down the turn. Arguments pass through to the
 * server verbatim: MCP servers define their own surface and sandboxing;
 * Ari's path jail applies to its built-in file tools only.
 */
export async function mountMcpTools(servers: MountedMcpServer[]): Promise<Tool[]> {
  const tools: Tool[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    let infos: McpToolInfo[]
    try {
      infos = await server.connection.listTools()
    } catch (error) {
      log.warn('mcp tools/list failed; omitting server', {
        server: server.name,
        error: String(error),
      })
      continue
    }
    for (const info of infos) {
      const name = mcpToolName(server.name, info.name)
      if (seen.has(name)) {
        log.warn('duplicate mcp tool name; keeping first', { name })
        continue
      }
      seen.add(name)
      tools.push({
        name,
        description:
          info.description ?? `MCP tool '${info.name}' provided by the ${server.name} server.`,
        parameters: info.inputSchema ?? { type: 'object', properties: {} },
        execute: async (args) => await server.connection.callTool(info.name, args),
      })
    }
  }
  return tools
}

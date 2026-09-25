import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { discoverExtensions, type ExtensionRecord } from '@ari/providers/extensions'
import { realDetectEnvironment, type DetectEnvironment } from '@ari/providers/types'
import type { McpServerConfig } from '@ari/ari-core/mcp-servers'
import { sanitizeMcpSegment } from '@ari/ari-core/mcp-tools'
import type { AriSkillRecord } from '@ari/ari-core/skills'

const READ_CAP = 64 * 1024

const BROWSER_SUMMARY =
  'HTTP preferred, same as session MCP selection. The stdio proxy is registered too. Which one is sent is decided when the turn starts. This page does not know mcpCapabilities.'

export function browserExtensionRecord(provider: DriverKind): ExtensionRecord {
  return {
    kind: 'mcp',
    scope: 'ari',
    provider,
    id: 'ari:browser',
    name: 'ari-browser',
    summary: BROWSER_SUMMARY,
    sourcePath: null,
    transport: 'http',
    disabled: false,
    delivery: 'injected',
  }
}

export async function buildExtensionInventory(input: {
  kind: DriverKind
  workspacePath: string | null
  env?: DetectEnvironment
  coreServers?: McpServerConfig[]
  coreSkills?: AriSkillRecord[]
}): Promise<RpcResults['providers.extensionInventory']> {
  if (input.kind === 'ari-core') {
    const records = [
      ...coreMcpRecords(input.coreServers ?? []),
      ...coreSkillRecords(input.coreSkills ?? []),
      browserExtensionRecord('ari-core'),
    ]
    return { records, truncated: false }
  }
  const discovered = await discoverExtensions({
    provider: input.kind,
    workspacePath: input.workspacePath,
    env: input.env ?? realDetectEnvironment(),
  })
  return {
    records: [...discovered.records, browserExtensionRecord(input.kind)],
    truncated: discovered.truncated,
  }
}

export async function readInventoriedSkill(
  inventory: RpcResults['providers.extensionInventory'],
  path: string,
): Promise<RpcResults['providers.readExtensionFile']> {
  const allowed = inventory.records.some(
    (record) => record.kind === 'skill' && record.sourcePath === path,
  )
  if (!allowed) throw new Error('that file is not a skill in this inventory')
  const raw = await readFile(path, 'utf8')
  const truncated = raw.length > READ_CAP
  return { content: truncated ? raw.slice(0, READ_CAP) : raw, truncated }
}

function coreMcpRecords(servers: McpServerConfig[]): ExtensionRecord[] {
  return servers.map((server) => ({
    kind: 'mcp' as const,
    scope: 'user' as const,
    provider: 'ari-core' as const,
    id: `ari-core:user:mcp:${server.id}:${server.name}`,
    name: server.name,
    sourcePath: null,
    transport: 'stdio' as const,
    command: basename(server.command),
    disabled: server.disabled,
    delivery: 'hosted' as const,
    ...(sanitizeMcpSegment(server.name) === 'ari_browser' ? { problem: 'duplicate-name' as const } : {}),
  }))
}

function coreSkillRecords(skills: AriSkillRecord[]): ExtensionRecord[] {
  return skills.map((skill) => ({
    kind: 'skill' as const,
    scope: skill.scope,
    provider: 'ari-core' as const,
    id: `ari-core:${skill.scope}:skill:${skill.sourcePath}:${skill.name}`,
    name: skill.name,
    ...(skill.summary ? { summary: skill.summary } : {}),
    sourcePath: skill.sourcePath,
    disabled: false,
    delivery: 'hosted' as const,
    ...(skill.problem ? { problem: skill.problem } : {}),
  }))
}

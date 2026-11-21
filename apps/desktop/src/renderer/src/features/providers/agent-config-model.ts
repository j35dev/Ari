import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'

export type ConfigFile = RpcResults['providers.configFiles']['files'][number]
export type InventoryRecord = RpcResults['providers.extensionInventory']['records'][number]
export type AgentTab = 'files' | 'skills' | 'mcp'

/**
 * Agents whose config layout Ari knows, in the order the switcher shows them.
 * The main process is the authority (an agent with no mapping answers with an
 * empty file list), but the switcher needs names before any call returns.
 */
export const AGENTS: readonly { kind: DriverKind; label: string }[] = [
  { kind: 'claude', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'grok', label: 'Grok' },
  { kind: 'pi', label: 'Pi' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'qoder', label: 'Qoder' },
  { kind: 'ari-core', label: 'Ari Core' },
]

export function agentLabel(kind: DriverKind): string {
  return AGENTS.find((agent) => agent.kind === kind)?.label ?? kind
}

/**
 * The agent the page opens on: the user's default agent when it has a page
 * here, else the first installed one in switcher order, else the first.
 */
export function pickInitialAgent(
  defaultKind: string | null | undefined,
  installed: ReadonlySet<string>,
): DriverKind {
  const preferred = AGENTS.find((agent) => agent.kind === defaultKind)
  if (preferred) return preferred.kind
  const firstInstalled = AGENTS.find((agent) => installed.has(agent.kind))
  return (firstInstalled ?? AGENTS[0]!).kind
}

/** Skills tab rows: skills, plus plugins (they add skills of their own). */
export function skillRecords(records: readonly InventoryRecord[]): InventoryRecord[] {
  return records.filter((record) => record.kind === 'skill' || record.kind === 'plugin')
}

export function mcpRecords(records: readonly InventoryRecord[]): InventoryRecord[] {
  return records.filter((record) => record.kind === 'mcp')
}

export type ScopeFilter = 'all' | 'user' | 'project' | 'plugin'

export interface ScopeChip {
  id: ScopeFilter
  label: string
  count: number
}

/** All, User and Project always; Plugin only when there is one. */
export function scopeChips(skills: readonly InventoryRecord[]): ScopeChip[] {
  const count = (scope: InventoryRecord['scope']): number =>
    skills.filter((skill) => skill.scope === scope).length
  const chips: ScopeChip[] = [
    { id: 'all', label: 'All', count: skills.length },
    { id: 'user', label: 'User', count: count('user') },
    { id: 'project', label: 'Project', count: count('project') },
  ]
  const plugins = count('plugin')
  if (plugins > 0) chips.push({ id: 'plugin', label: 'Plugin', count: plugins })
  return chips
}

/** Case-insensitive match on name and summary, within one scope. */
export function filterSkills(
  skills: readonly InventoryRecord[],
  query: string,
  scope: ScopeFilter,
): InventoryRecord[] {
  const needle = query.trim().toLowerCase()
  return skills.filter(
    (skill) =>
      (scope === 'all' || skill.scope === scope) &&
      (needle.length === 0 ||
        skill.name.toLowerCase().includes(needle) ||
        (skill.summary ?? '').toLowerCase().includes(needle)),
  )
}

export const SCOPE_LABEL: Record<InventoryRecord['scope'], string> = {
  user: 'User',
  project: 'Project',
  plugin: 'Plugin',
  ari: 'Added by Ari',
}

export const PROBLEM_LABEL: Record<NonNullable<InventoryRecord['problem']>, string> = {
  'missing-binary': 'Missing binary',
  unreadable: 'Unreadable',
  'duplicate-name': 'Name collides with ari-browser',
  'untrusted-project': 'Not trusted',
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
}

/** The file name at the end of a path, either separator. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

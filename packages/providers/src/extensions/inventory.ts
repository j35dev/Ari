import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { providerConfigDir } from '../config-files'
import type { DetectEnvironment } from '../types'

/**
 * Read-only inventory of the skills, MCP servers, and plugins a pass-through
 * agent already loads from disk. Ari does not spawn those servers and does
 * not copy them onto `session/new` — the records are names for the settings
 * page. Secrets (env, headers, args, URLs) never leave this module.
 */

export type ExtensionScope = 'user' | 'project' | 'plugin' | 'ari'
export type ExtensionKind = 'mcp' | 'skill' | 'plugin'

export interface ExtensionRecord {
  kind: ExtensionKind
  scope: ExtensionScope
  provider: DriverKind
  /** Includes `sourcePath` so two files that share a name stay distinct. */
  id: string
  name: string
  summary?: string
  sourcePath: string | null
  transport?: 'stdio' | 'http' | 'sse' | 'unknown'
  /** Basename only. Never argv. */
  command?: string
  disabled: boolean
  delivery: 'delegated' | 'injected' | 'hosted'
  problem?: 'missing-binary' | 'unreadable' | 'duplicate-name' | 'untrusted-project'
}

export interface ExtensionInventory {
  records: ExtensionRecord[]
  truncated: boolean
}

const SKILL_CAP = 80
const MCP_CAP = 40
const PLUGIN_CAP = 40
const SKILL_READ_CAP = 16 * 1024
const SUMMARY_CAP = 160

export interface DiscoverExtensionsInput {
  provider: DriverKind
  workspacePath: string | null
  env: DetectEnvironment
}

interface McpHit {
  name: string
  sourcePath: string
  scope: ExtensionScope
  disabled: boolean
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  command?: string
  problem?: ExtensionRecord['problem']
}

interface SkillHit {
  name: string
  summary?: string
  sourcePath: string
  scope: ExtensionScope
  disabled: boolean
  problem?: ExtensionRecord['problem']
}

/** Frontmatter `name` / `description`, or the directory name when the block is bad. */
export function parseSkillFrontmatter(
  raw: string,
  dirName: string,
): { name: string; summary?: string; problem?: 'unreadable' } {
  if (!raw.startsWith('---')) return { name: dirName }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { name: dirName, problem: 'unreadable' }
  let name = dirName
  let summary: string | undefined
  let sawField = false
  for (const line of raw.slice(3, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    sawField = true
    const key = match[1]
    const value = unquote(match[2] ?? '')
    if (key === 'name' && value.length > 0) name = value
    if (key === 'description' && value.length > 0) summary = value.slice(0, SUMMARY_CAP)
  }
  if (!sawField) return { name: dirName, problem: 'unreadable' }
  return summary ? { name, summary } : { name }
}

/**
 * One skill directory. Returns null when `SKILL.md` is missing or its
 * canonical path leaves `skillsRootReal` (symlink jail).
 */
export async function readSkillDirectory(
  dir: string,
  skillsRootReal: string,
): Promise<{ name: string; summary?: string; sourcePath: string; problem?: 'unreadable' } | null> {
  const skillFile = join(dir, 'SKILL.md')
  let fileReal: string
  let rootReal: string
  try {
    rootReal = realpathSync(skillsRootReal)
    fileReal = realpathSync(skillFile)
  } catch {
    return null
  }
  if (!isInside(fileReal, rootReal)) return null
  let raw: string
  try {
    raw = await readFile(skillFile, 'utf8')
  } catch {
    return {
      name: basename(dir),
      sourcePath: skillFile,
      problem: 'unreadable',
    }
  }
  if (raw.length > SKILL_READ_CAP) raw = raw.slice(0, SKILL_READ_CAP)
  const parsed = parseSkillFrontmatter(raw, basename(dir))
  return { ...parsed, sourcePath: skillFile }
}

export async function discoverExtensions(input: DiscoverExtensionsInput): Promise<ExtensionInventory> {
  const skills: SkillHit[] = []
  const mcps: McpHit[] = []
  const plugins: { name: string; sourcePath: string }[] = []
  const home = input.env.homeDir
  const configDir = providerConfigDir(input.provider, input.env)
  const walked = input.workspacePath ? projectDirs(input.workspacePath) : []

  if (input.provider === 'claude' && configDir) {
    await collectSkills(join(configDir, 'skills'), 'user', skills)
    await collectClaudeMcpFile(join(configDir, 'settings.json'), 'user', mcps)
    await collectClaudePlugins(join(configDir, 'settings.json'), plugins)
    if (home) await collectClaudeMcpFile(join(home, '.claude.json'), 'user', mcps)
    for (const dir of walked) {
      await collectSkills(join(dir, '.claude', 'skills'), 'project', skills)
      await collectClaudeMcpFile(join(dir, '.mcp.json'), 'project', mcps)
    }
  }

  if (input.provider === 'codex') {
    if (home) await collectSkills(join(home, '.agents', 'skills'), 'user', skills)
    if (configDir) {
      const toml = join(configDir, 'config.toml')
      await collectTomlMcp(toml, 'user', mcps)
      await applySkillConfig(toml, skills)
    }
    for (const dir of walked) {
      await collectSkills(join(dir, '.agents', 'skills'), 'project', skills)
      const toml = join(dir, '.codex', 'config.toml')
      await collectTomlMcp(toml, 'project', mcps)
      await applySkillConfig(toml, skills)
    }
  }

  if (input.provider === 'grok' && configDir) {
    await collectSkills(join(configDir, 'skills'), 'user', skills)
    await collectTomlMcp(join(configDir, 'config.toml'), 'user', mcps)
    for (const dir of walked) {
      await collectSkills(join(dir, '.grok', 'skills'), 'project', skills)
      await collectTomlMcp(join(dir, '.grok', 'config.toml'), 'project', mcps)
    }
  }

  if (input.provider === 'opencode') {
    if (configDir) {
      await collectSkills(join(configDir, 'skills'), 'user', skills)
      await collectOpenCodeMcp(join(configDir, 'opencode.json'), 'user', mcps)
      await collectOpenCodeMcp(join(configDir, 'opencode.jsonc'), 'user', mcps)
    }
    for (const dir of walked) {
      await collectSkills(join(dir, '.opencode', 'skills'), 'project', skills)
      await collectSkills(join(dir, '.agents', 'skills'), 'project', skills)
      await collectOpenCodeMcp(join(dir, 'opencode.json'), 'project', mcps)
    }
  }

  if (input.provider === 'pi' && configDir) {
    await collectPiSkillNames(join(configDir, 'settings.json'), 'user', skills)
    for (const dir of walked) {
      await collectPiSkillNames(join(dir, '.pi', 'settings.json'), 'project', skills)
    }
  }

  return capRecords(input.provider, skills, mcps, plugins)
}

/** Directories from `cwd` up through the git root, or just `cwd` when there is no `.git`. */
export function projectDirs(cwd: string): string[] {
  const start = resolve(cwd)
  const chain: string[] = []
  let current = start
  let gitAt = -1
  for (let step = 0; step < 8; step++) {
    chain.push(current)
    if (existsSync(join(current, '.git'))) {
      gitAt = chain.length - 1
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (gitAt === -1) return [start]
  return chain.slice(0, gitAt + 1)
}

function capRecords(
  provider: DriverKind,
  skills: SkillHit[],
  mcps: McpHit[],
  plugins: { name: string; sourcePath: string }[],
): ExtensionInventory {
  const truncated = skills.length > SKILL_CAP || mcps.length > MCP_CAP || plugins.length > PLUGIN_CAP
  const records: ExtensionRecord[] = []
  for (const skill of skills.slice(0, SKILL_CAP)) {
    records.push({
      kind: 'skill',
      scope: skill.scope,
      provider,
      id: recordId(provider, skill.scope, 'skill', skill.sourcePath, skill.name),
      name: skill.name,
      ...(skill.summary ? { summary: skill.summary } : {}),
      sourcePath: skill.sourcePath,
      disabled: skill.disabled,
      delivery: 'delegated',
      ...(skill.problem ? { problem: skill.problem } : {}),
    })
  }
  for (const mcp of mcps.slice(0, MCP_CAP)) {
    const problem = mcp.problem ?? (mcp.name === 'ari-browser' ? 'duplicate-name' : undefined)
    records.push({
      kind: 'mcp',
      scope: mcp.scope,
      provider,
      id: recordId(provider, mcp.scope, 'mcp', mcp.sourcePath, mcp.name),
      name: mcp.name,
      sourcePath: mcp.sourcePath,
      transport: mcp.transport,
      ...(mcp.command ? { command: mcp.command } : {}),
      disabled: mcp.disabled,
      delivery: 'delegated',
      ...(problem ? { problem } : {}),
    })
  }
  for (const plugin of plugins.slice(0, PLUGIN_CAP)) {
    records.push({
      kind: 'plugin',
      scope: 'plugin',
      provider,
      id: recordId(provider, 'plugin', 'plugin', plugin.sourcePath, plugin.name),
      name: plugin.name,
      sourcePath: plugin.sourcePath,
      disabled: false,
      delivery: 'delegated',
    })
  }
  return { records, truncated }
}

function recordId(
  provider: DriverKind,
  scope: ExtensionScope,
  kind: ExtensionKind,
  sourcePath: string | null,
  name: string,
): string {
  return `${provider}:${scope}:${kind}:${sourcePath ?? 'ari'}:${name}`
}

async function collectSkills(root: string, scope: ExtensionScope, into: SkillHit[]): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (!lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink()) continue
    } catch {
      continue
    }
    const skill = await readSkillDirectory(dir, rootReal)
    if (!skill) continue
    into.push({
      name: skill.name,
      ...(skill.summary ? { summary: skill.summary } : {}),
      sourcePath: skill.sourcePath,
      scope,
      disabled: false,
      ...(skill.problem ? { problem: skill.problem } : {}),
    })
  }
}

async function collectClaudeMcpFile(file: string, scope: ExtensionScope, into: McpHit[]): Promise<void> {
  const parsed = await readJson(file)
  if (parsed === 'missing') return
  if (parsed === 'bad') {
    into.push(unreadableMcp(basename(file), file, scope))
    return
  }
  const servers = asRecord(parsed['mcpServers'])
  if (!servers) return
  for (const [name, value] of Object.entries(servers)) {
    into.push(mcpFromValue(name, value, file, scope))
  }
}

async function collectClaudePlugins(
  file: string,
  into: { name: string; sourcePath: string }[],
): Promise<void> {
  const parsed = await readJson(file)
  if (parsed === 'missing' || parsed === 'bad') return
  const plugins = parsed['plugins']
  if (Array.isArray(plugins)) {
    for (const entry of plugins) {
      if (typeof entry === 'string' && entry.length > 0) into.push({ name: entry, sourcePath: file })
    }
    return
  }
  const record = asRecord(plugins)
  if (!record) return
  for (const [name, value] of Object.entries(record)) {
    if (value === false) continue
    into.push({ name, sourcePath: file })
  }
}

async function collectTomlMcp(file: string, scope: ExtensionScope, into: McpHit[]): Promise<void> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return
  }
  into.push(...scanTomlMcp(text, file, scope))
}

async function applySkillConfig(file: string, skills: SkillHit[]): Promise<void> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return
  }
  for (const row of scanSkillConfig(text)) {
    if (row.enabled) continue
    const target = resolve(row.path)
    for (const skill of skills) {
      if (resolve(skill.sourcePath) === target || resolve(dirname(skill.sourcePath)) === target) {
        skill.disabled = true
      }
    }
  }
}

async function collectOpenCodeMcp(file: string, scope: ExtensionScope, into: McpHit[]): Promise<void> {
  const parsed = await readJson(file, true)
  if (parsed === 'missing') return
  if (parsed === 'bad') {
    into.push(unreadableMcp(basename(file), file, scope))
    return
  }
  const servers = asRecord(parsed['mcp'])
  if (!servers) return
  for (const [name, value] of Object.entries(servers)) {
    into.push(mcpFromValue(name, value, file, scope))
  }
}

async function collectPiSkillNames(file: string, scope: ExtensionScope, into: SkillHit[]): Promise<void> {
  const parsed = await readJson(file)
  if (parsed === 'missing' || parsed === 'bad') return
  const skills = parsed['skills']
  if (!Array.isArray(skills)) return
  for (const entry of skills) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    into.push({
      name: basename(entry),
      sourcePath: file,
      scope,
      disabled: false,
    })
  }
}

function mcpFromValue(name: string, value: unknown, file: string, scope: ExtensionScope): McpHit {
  const record = asRecord(value)
  if (!record) return { ...unreadableMcp(name, file, scope), name }
  const type = typeof record['type'] === 'string' ? record['type'] : ''
  const url = typeof record['url'] === 'string' ? record['url'] : ''
  const commandRaw = commandString(record['command'])
  let transport: McpHit['transport'] = 'unknown'
  if (type === 'sse') transport = 'sse'
  else if (type === 'http' || url.length > 0) transport = 'http'
  else if (commandRaw) transport = 'stdio'
  const disabled = record['disabled'] === true || record['enabled'] === false
  let problem: McpHit['problem']
  if (commandRaw && isAbsolute(commandRaw) && !existsSync(commandRaw)) problem = 'missing-binary'
  return {
    name,
    sourcePath: file,
    scope,
    disabled,
    transport,
    ...(commandRaw ? { command: basename(commandRaw) } : {}),
    ...(problem ? { problem } : {}),
  }
}

function commandString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0]
  return null
}

function unreadableMcp(name: string, file: string, scope: ExtensionScope): McpHit {
  return {
    name,
    sourcePath: file,
    scope,
    disabled: false,
    transport: 'unknown',
    problem: 'unreadable',
  }
}

/** Line scan. A new `[` header ends the open table. Inline `mcp_servers.x = {` is ignored. */
export function scanTomlMcp(text: string, file: string, scope: ExtensionScope): McpHit[] {
  const hits: McpHit[] = []
  let current: { name: string; command?: string; url?: string; disabled: boolean } | null = null
  const flush = (): void => {
    if (!current) return
    let transport: McpHit['transport'] = 'unknown'
    if (current.url) transport = 'http'
    else if (current.command) transport = 'stdio'
    let problem: McpHit['problem']
    if (current.command && isAbsolute(current.command) && !existsSync(current.command)) {
      problem = 'missing-binary'
    }
    hits.push({
      name: current.name,
      sourcePath: file,
      scope,
      disabled: current.disabled,
      transport,
      ...(current.command ? { command: basename(current.command) } : {}),
      ...(problem ? { problem } : {}),
    })
    current = null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      flush()
      const header = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/.exec(trimmed)
      if (header?.[1]) current = { name: header[1], disabled: false }
      continue
    }
    if (!current || trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = unquote(trimmed.slice(eq + 1).trim())
    if (key === 'command') current.command = value
    if (key === 'url') current.url = value
    if (key === 'enabled' && value === 'false') current.disabled = true
  }
  flush()
  return hits
}

export function scanSkillConfig(text: string): { path: string; enabled: boolean }[] {
  const rows: { path: string; enabled: boolean }[] = []
  let open = false
  let path = ''
  let enabled = true
  const flush = (): void => {
    if (open && path.length > 0) rows.push({ path, enabled })
    open = false
    path = ''
    enabled = true
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      flush()
      open = /^\[\[skills\.config\]\]\s*$/.test(trimmed)
      continue
    }
    if (!open) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = unquote(trimmed.slice(eq + 1).trim())
    if (key === 'path') path = value
    if (key === 'enabled' && value === 'false') enabled = false
  }
  flush()
  return rows
}

async function readJson(file: string, jsonc = false): Promise<Record<string, unknown> | 'missing' | 'bad'> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return 'missing'
  }
  try {
    const parsed: unknown = JSON.parse(jsonc ? stripJsonc(text) : text)
    return asRecord(parsed) ?? 'bad'
  } catch {
    return 'bad'
  }
}

function stripJsonc(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/,\s*$/, '')
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isInside(target: string, root: string): boolean {
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  return t === r || t.startsWith(`${r}${process.platform === 'win32' ? '\\' : '/'}`) || t.startsWith(`${r}/`)
}

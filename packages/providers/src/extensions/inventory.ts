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
 * page. Secrets never leave this module: env and header values stay behind
 * (only env key names go out), URLs lose their query and credentials, and
 * args that look like a secret, or follow a flag that names one, are masked.
 */

/** What a masked value reads as on the settings page. */
export const SECRET_MASK = '••••'

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
  /** Basename only. */
  command?: string
  /** MCP argv after the command, secrets masked (see {@link redactArgs}). */
  args?: string[]
  /** Names of the env vars the server is given. Never their values. */
  envKeys?: string[]
  /** HTTP/SSE endpoint without query, fragment or credentials. */
  url?: string
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
  args?: string[]
  envKeys?: string[]
  url?: string
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
  const text = raw.replace(/\r\n?/g, '\n')
  if (!text.startsWith('---')) return { name: dirName }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { name: dirName, problem: 'unreadable' }
  const fields = frontmatterFields(text.slice(3, end))
  if (fields.size === 0) return { name: dirName, problem: 'unreadable' }
  const name = oneLine(fields.get('name') ?? '') || dirName
  const summary = oneLine(fields.get('description') ?? '').slice(0, SUMMARY_CAP)
  return summary ? { name, summary } : { name }
}

/**
 * Top-level scalar fields of a YAML frontmatter block. Enough YAML for skill
 * headers: plain and quoted values, values continued on indented lines, and
 * `|` / `>` block scalars (with chomping and indent indicators). Nested
 * mappings are skipped; only unindented keys count.
 */
function frontmatterFields(block: string): Map<string, string> {
  const fields = new Map<string, string>()
  const lines = block.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index] ?? '')
    if (!match?.[1]) continue
    const head = (match[2] ?? '').trim()
    // Lines that belong to this key: blank, or indented past it.
    const body: string[] = []
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? ''
      if (next.trim().length > 0 && !/^\s/.test(next)) break
      body.push(next)
      index++
    }
    while (body.length > 0 && (body[body.length - 1] ?? '').trim().length === 0) body.pop()
    const block = /^([|>])([+-]?\d?|\d?[+-]?)\s*(?:#.*)?$/.exec(head)
    if (block) {
      fields.set(
        match[1],
        blockScalar(body, block[1] === '|' ? 'literal' : 'folded', block[2] ?? ''),
      )
    } else {
      const continued = body.length > 0 ? `${head}\n${body.join('\n')}` : head
      fields.set(match[1], unquoteScalar(fold(continued.split('\n').map((line) => line.trim()))))
    }
  }
  return fields
}

/** The text of a `|` or `>` block scalar, its indentation removed. */
function blockScalar(body: string[], style: 'literal' | 'folded', indicator: string): string {
  const explicit = /\d/.exec(indicator)?.[0]
  const first = body.find((line) => line.trim().length > 0)
  const indent =
    explicit !== undefined ? Number(explicit) : first ? (/^\s*/.exec(first)?.[0].length ?? 0) : 0
  const content = body.map((line) =>
    line.slice(Math.min(indent, /^\s*/.exec(line)?.[0].length ?? 0)),
  )
  return style === 'literal' ? content.join('\n') : fold(content)
}

/** YAML folding: lines join with a space, an empty line becomes a newline. */
function fold(lines: string[]): string {
  let out = ''
  let pendingBreak = false
  for (const line of lines) {
    if (line.trim().length === 0) {
      out += '\n'
      pendingBreak = true
      continue
    }
    out += out.length === 0 || pendingBreak ? line : ` ${line}`
    pendingBreak = false
  }
  return out
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(["\\/nt])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

/** Collapses a multi-line value onto the one line a summary row has. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
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

export async function discoverExtensions(
  input: DiscoverExtensionsInput,
): Promise<ExtensionInventory> {
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

  return capRecords(input.provider, uniqueBySource(skills), uniqueBySource(mcps), plugins)
}

/**
 * Drops a hit whose file was already collected under an earlier scope. With no
 * session open the project walk starts at home, so `~/.claude/skills` would
 * otherwise show up as both a user and a project skill.
 */
function uniqueBySource<T extends { sourcePath: string; name: string }>(hits: T[]): T[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const path = resolve(hit.sourcePath)
    const key = `${process.platform === 'win32' ? path.toLowerCase() : path}\u0000${hit.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  const truncated =
    skills.length > SKILL_CAP || mcps.length > MCP_CAP || plugins.length > PLUGIN_CAP
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
      ...(mcp.args && mcp.args.length > 0 ? { args: mcp.args } : {}),
      ...(mcp.envKeys && mcp.envKeys.length > 0 ? { envKeys: mcp.envKeys } : {}),
      ...(mcp.url ? { url: mcp.url } : {}),
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

async function collectClaudeMcpFile(
  file: string,
  scope: ExtensionScope,
  into: McpHit[],
): Promise<void> {
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
      if (typeof entry === 'string' && entry.length > 0)
        into.push({ name: entry, sourcePath: file })
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

async function collectOpenCodeMcp(
  file: string,
  scope: ExtensionScope,
  into: McpHit[],
): Promise<void> {
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

async function collectPiSkillNames(
  file: string,
  scope: ExtensionScope,
  into: SkillHit[],
): Promise<void> {
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
  // OpenCode puts the whole argv in `command`; Claude splits it into `args`.
  const command: unknown = record['command']
  const args: unknown = record['args']
  const argv = [
    ...(Array.isArray(command) ? (command as unknown[]).slice(1) : []),
    ...(Array.isArray(args) ? (args as unknown[]) : []),
  ].filter((arg): arg is string => typeof arg === 'string')
  const envKeys = Object.keys(asRecord(record['env']) ?? asRecord(record['environment']) ?? {})
  const safeUrl = url.length > 0 ? sanitizeUrl(url) : null
  return {
    name,
    sourcePath: file,
    scope,
    disabled,
    transport,
    ...(commandRaw ? { command: basename(commandRaw) } : {}),
    ...(argv.length > 0 ? { args: redactArgs(argv) } : {}),
    ...(envKeys.length > 0 ? { envKeys } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
    ...(problem ? { problem } : {}),
  }
}

function commandString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0]
  return null
}

/** Flag or key names whose value is a credential. Over-matching only over-masks. */
const SECRET_NAME = /key|token|secret|passw|pwd|auth|bearer|credential|cookie|session/i
/** Prefixes of well-known credential formats. */
const SECRET_PREFIX =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|eyJ)/

/**
 * MCP argv with credentials masked: `--token=x` and `API_KEY=x` keep their
 * name, the value after `--api-key` goes, as do values shaped like a known
 * token or a long opaque string. URLs lose their query and credentials.
 */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const previous = index > 0 ? args[index - 1] : undefined
    if (
      previous !== undefined &&
      /^--?[A-Za-z]/.test(previous) &&
      !previous.includes('=') &&
      SECRET_NAME.test(previous)
    ) {
      return SECRET_MASK
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return sanitizeUrl(arg) ?? SECRET_MASK
    const pair = /^([^=:\s]+)(\s*[=:]\s*)(.+)$/.exec(arg)
    if (pair?.[1] && SECRET_NAME.test(pair[1])) return `${pair[1]}${pair[2] ?? '='}${SECRET_MASK}`
    if (looksLikeSecret(arg)) return SECRET_MASK
    return arg
  })
}

function looksLikeSecret(value: string): boolean {
  if (SECRET_PREFIX.test(value)) return true
  // Long opaque tokens: no path separators, mixed letters and digits.
  return (
    value.length >= 32 &&
    /^[A-Za-z0-9_\-+=.]+$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value)
  )
}

/** Origin and path only; null when it does not parse as a URL. */
export function sanitizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return null
  }
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
  interface Open {
    name: string
    command?: string
    url?: string
    args: string[]
    envKeys: string[]
    disabled: boolean
  }
  const servers: Open[] = []
  /** The server the current table belongs to, and whether it is its `.env` subtable. */
  let current: Open | null = null
  let inEnv = false
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? '').trim()
    if (trimmed.startsWith('[')) {
      current = null
      inEnv = false
      const header = /^\[mcp_servers\.([A-Za-z0-9_-]+)(\.env)?\]\s*$/.exec(trimmed)
      if (header?.[1]) {
        const name = header[1]
        current = servers.find((server) => server.name === name) ?? null
        if (!current) {
          current = { name, args: [], envKeys: [], disabled: false }
          servers.push(current)
        }
        inEnv = header[2] !== undefined
      }
      continue
    }
    if (!current || trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = unquote(trimmed.slice(0, eq).trim())
    let raw = trimmed.slice(eq + 1).trim()
    if (inEnv) {
      current.envKeys.push(key)
      continue
    }
    // A multi-line array runs until its closing bracket.
    if (raw.startsWith('[') && !raw.includes(']')) {
      while (index + 1 < lines.length && !raw.includes(']'))
        raw += ` ${lines[++index]?.trim() ?? ''}`
    }
    const value = unquote(raw)
    if (key === 'command') current.command = value
    if (key === 'url') current.url = value
    if (key === 'enabled' && value === 'false') current.disabled = true
    if (key === 'args') current.args = tomlStrings(raw)
    if (key === 'env') current.envKeys.push(...inlineTableKeys(raw))
  }
  return servers.map((server) => {
    let transport: McpHit['transport'] = 'unknown'
    if (server.url) transport = 'http'
    else if (server.command) transport = 'stdio'
    let problem: McpHit['problem']
    if (server.command && isAbsolute(server.command) && !existsSync(server.command)) {
      problem = 'missing-binary'
    }
    const safeUrl = server.url ? sanitizeUrl(server.url) : null
    return {
      name: server.name,
      sourcePath: file,
      scope,
      disabled: server.disabled,
      transport,
      ...(server.command ? { command: basename(server.command) } : {}),
      ...(server.args.length > 0 ? { args: redactArgs(server.args) } : {}),
      ...(server.envKeys.length > 0 ? { envKeys: server.envKeys } : {}),
      ...(safeUrl ? { url: safeUrl } : {}),
      ...(problem ? { problem } : {}),
    }
  })
}

/** The strings of a one-line TOML array: `["-y", 'pkg']`. */
function tomlStrings(raw: string): string[] {
  const out: string[] = []
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : (match[2] ?? ''))
  }
  return out
}

/** Key names of a TOML inline table, `{ A = "x", "B" = "y" }`. Values are dropped. */
function inlineTableKeys(raw: string): string[] {
  const inner = /^\{(.*)\}$/.exec(raw.trim())?.[1]
  if (inner === undefined) return []
  const keys: string[] = []
  for (const match of inner.matchAll(/(?:^|,)\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/g)) {
    if (match[1]) keys.push(unquote(match[1]))
  }
  return keys
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

async function readJson(
  file: string,
  jsonc = false,
): Promise<Record<string, unknown> | 'missing' | 'bad'> {
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
  return (
    t === r ||
    t.startsWith(`${r}${process.platform === 'win32' ? '\\' : '/'}`) ||
    t.startsWith(`${r}/`)
  )
}

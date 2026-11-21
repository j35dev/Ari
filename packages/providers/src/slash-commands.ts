import {
  isHiddenSlashCommand,
  type SlashCommand,
  type SlashCommandSource,
} from '@ari/contracts/slash-commands'

/**
 * Normalizes each provider's slash-command list into Ari's shape and decides
 * how each command runs inside Ari. Ari features that already do a command's
 * job win over the provider's command, so the two never both act on it.
 */

/** Built-in commands Ari answers with its own controls, never by sending them. */
const ARI_NATIVE: Record<string, string> = {
  model: "Choose the model with Ari's model picker under the message box.",
  effort: "Choose the effort level with Ari's model picker under the message box.",
  permissions: "Choose what the agent may do with Ari's permission picker under the message box.",
  approvals: "Choose what the agent may do with Ari's permission picker under the message box.",
  clear:
    'Start a new chat in Ari instead. This would empty the agent’s context while Ari still shows the conversation.',
  new: 'Start a new chat in Ari instead.',
  reset: 'Start a new chat in Ari instead.',
  resume: 'Open earlier chats from Ari’s sidebar.',
  login: 'Sign in from Ari’s provider settings.',
  logout: 'Sign out from Ari’s provider settings.',
}

function nativeReason(name: string): string | undefined {
  return ARI_NATIVE[name.toLowerCase()]
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function commandName(value: unknown): string {
  return text(value, 200).replace(/^\/+/, '')
}

function hint(value: unknown): string | null {
  const out = text(value, 500)
  return out.length > 0 ? out : null
}

/** A provider built-in, unless Ari hides it or answers it natively. */
function builtin(
  entry: Omit<SlashCommand, 'run' | 'source'> & { source?: SlashCommandSource },
  hidden?: ReadonlySet<string>,
): SlashCommand | null {
  if (isHiddenSlashCommand(entry.name, hidden)) return null
  const reason = nativeReason(entry.name)
  return {
    ...entry,
    source: entry.source ?? 'builtin',
    run: reason ? 'unsupported' : 'prompt-text',
    ...(reason ? { reason } : {}),
  }
}

/** True when a name or description marks an MCP server's prompt. */
function looksLikeMcp(name: string, description: string): boolean {
  return name.startsWith('mcp__') || /\(MCP\)\s*$/.test(description)
}

/**
 * ACP `available_commands_update`: every advertised command runs by sending
 * `/name args` as the prompt, which is how the spec says clients invoke them.
 * Returns null for any other update.
 */
export function acpCommandsFromUpdate(update: unknown): SlashCommand[] | null {
  if (update === null || typeof update !== 'object') return null
  const record = update as { sessionUpdate?: unknown; availableCommands?: unknown }
  if (record.sessionUpdate !== 'available_commands_update') return null
  if (!Array.isArray(record.availableCommands)) return []
  const commands: SlashCommand[] = []
  for (const raw of record.availableCommands as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null }
    const name = commandName(item.name)
    if (name.length === 0) continue
    const description = text(item.description, 2_000)
    const entry = builtin({
      name,
      description,
      argumentHint: hint(item.input?.hint),
      source: name.startsWith('$') ? 'skill' : looksLikeMcp(name, description) ? 'mcp' : 'builtin',
    })
    if (entry) commands.push(entry)
  }
  return dedupe(commands)
}

/** One entry of the Claude SDK's `supportedCommands()` / `initializationResult().commands`. */
export interface ClaudeSdkCommand {
  name: string
  description?: string
  argumentHint?: string
  aliases?: string[]
  builtin?: boolean
}

export interface ClaudeCommandContext {
  /** `system/init.terminal_slash_commands`: names bound to the terminal. */
  terminal?: readonly string[]
  /** Skills the session loaded (`system/init.skills`, or the on-disk inventory). */
  skills?: readonly string[]
}

/** Claude marks where a custom command lives at the end of its description. */
const SCOPE_SUFFIX = /\s*\((project|user)\)\s*$/

/**
 * Claude Code expands every command it lists when the prompt is the command
 * itself, so all of them run as prompt text, minus the terminal-bound ones
 * and the ones Ari's own controls handle.
 */
export function claudeSlashCommands(
  commands: readonly ClaudeSdkCommand[],
  context: ClaudeCommandContext = {},
): SlashCommand[] {
  const terminal = new Set((context.terminal ?? []).map((name) => name.toLowerCase()))
  const skills = new Set((context.skills ?? []).map((name) => name.toLowerCase()))
  // A built-in row owns its name: `/name` runs it even when a user command
  // shares the name, so that user row would only mislead.
  const builtinNames = new Set(
    commands
      .filter((command) => command.builtin === true)
      .map((c) => commandName(c.name).toLowerCase()),
  )
  const out: SlashCommand[] = []
  for (const command of commands) {
    const name = commandName(command.name)
    if (name.length === 0) continue
    if (command.builtin !== true && builtinNames.has(name.toLowerCase())) continue
    const described = text(command.description, 2_000)
    const scope = command.builtin === true ? null : (SCOPE_SUFFIX.exec(described)?.[1] ?? null)
    const description = scope === null ? described : described.replace(SCOPE_SUFFIX, '')
    const aliases = (command.aliases ?? []).map(commandName).filter((alias) => alias.length > 0)
    const base = {
      name,
      description,
      argumentHint: hint(command.argumentHint),
      ...(aliases.length > 0 ? { aliases: aliases.slice(0, 20) } : {}),
    }
    if (command.builtin === true) {
      // An alias Ari answers natively (`/new` for `/clear`) blocks the whole command.
      const entry = builtin(base, terminal)
      if (entry) out.push(entry)
      continue
    }
    if (terminal.has(name.toLowerCase())) continue
    const key = name.toLowerCase()
    const source: SlashCommandSource = looksLikeMcp(name, description)
      ? 'mcp'
      : skills.has(key)
        ? 'skill'
        : scope === 'project'
          ? 'project'
          : 'user'
    out.push({ ...base, source, run: 'prompt-text' })
  }
  return dedupe(out)
}

/** One Codex skill as `skills/list` reports it. */
export interface CodexSkill {
  name: string
  description?: string
  shortDescription?: string
  enabled?: boolean
}

/**
 * The Codex TUI's own commands. The app-server lists none of them: they are
 * client-side in the terminal app. Ari runs the ones the app-server exposes
 * as methods and explains the rest; names in {@link TUI_ONLY_SLASH_COMMANDS}
 * are hidden instead.
 */
const CODEX_COMMANDS: readonly Omit<SlashCommand, 'source'>[] = [
  {
    name: 'compact',
    description: 'Summarize the conversation to free up context',
    argumentHint: null,
    run: 'rpc',
  },
  {
    name: 'review',
    description: 'Review the current changes and find issues',
    argumentHint: '[instructions]',
    run: 'rpc',
  },
  {
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    argumentHint: '[<objective>|clear|pause|resume]',
    run: 'rpc',
  },
  ...(
    [
      ['model', 'Choose the model and reasoning effort'],
      ['permissions', 'Choose what Codex is allowed to do'],
      ['approvals', 'Choose what Codex is allowed to do'],
      ['new', 'Start a new chat'],
      ['clear', 'Clear the terminal and start a new chat'],
      ['resume', 'Resume a saved chat'],
      ['logout', 'Log out of Codex'],
    ] as const
  ).map(([name, description]) => ({
    name,
    description,
    argumentHint: null,
    run: 'unsupported' as const,
    reason: ARI_NATIVE[name],
  })),
  ...(
    [
      ['fork', 'Fork the current chat', 'Ari does not fork Codex threads yet.'],
      [
        'status',
        'Show the session configuration and token usage',
        'Ari shows the model, context use and account usage around the message box.',
      ],
      ['usage', 'View account usage', 'Ari’s usage pill shows Codex account usage.'],
      ['diff', 'Show the git diff', 'Open the Changes panel to see the diff.'],
      ['mention', 'Mention a file', 'Type @ in the message box to mention a file.'],
      ['mcp', 'List MCP tools', 'Ari’s provider settings list the MCP servers Codex loads.'],
      ['skills', 'Use skills', 'Codex skills are listed in this menu; pick one to use it.'],
      [
        'init',
        'Create an AGENTS.md file',
        'Codex expands /init only in its terminal app. Ask for an AGENTS.md in your own words instead.',
      ],
      ['rename', 'Rename the current thread', 'Rename the chat from Ari’s sidebar.'],
      ['plan', 'Switch to Plan mode', 'Codex Plan mode is not available through Ari yet.'],
      [
        'agent',
        'Open the agent command center',
        'Ari shows Codex sub-agents in the agents row above the message box.',
      ],
      [
        'subagents',
        'Switch between sub-agents',
        'Ari shows Codex sub-agents in the agents row above the message box.',
      ],
      ['side', 'Start a side conversation', 'Start another chat in Ari instead.'],
      ['btw', 'Ask a side question', 'Start another chat in Ari instead.'],
      ['recap', 'Summarize the conversation now', 'Ask Codex for a summary in your own words.'],
      ['archive', 'Archive this session', 'Archive the chat from Ari’s sidebar.'],
      ['delete', 'Delete this session', 'Delete the chat from Ari’s sidebar.'],
      ['copy', 'Copy the last response', 'Use the copy button under the response.'],
      [
        'export',
        'Export the conversation as markdown',
        'Codex exports only from its terminal app.',
      ],
      [
        'worktree',
        'Continue in a new git worktree',
        'Codex worktrees are only available in its terminal app.',
      ],
      ['personality', 'Choose a personality', 'Codex changes this only in its terminal app.'],
      [
        'experimental',
        'Toggle experimental features',
        'Change Codex features in its config file or terminal app.',
      ],
      ['memories', 'Configure memory use', 'Change Codex memory settings in its terminal app.'],
      ['hooks', 'Manage lifecycle hooks', 'Manage Codex hooks in its terminal app.'],
      ['apps', 'Manage apps', 'Manage Codex apps in its terminal app.'],
      ['plugins', 'Browse plugins', 'Browse Codex plugins in its terminal app.'],
      ['import', 'Import setup from Claude Code', 'Codex imports only from its terminal app.'],
      ['feedback', 'Send logs to the maintainers', 'Send Codex feedback from its terminal app.'],
      ['ps', 'List background terminals', 'Ari shows Codex background work in the agents row.'],
      [
        'clean',
        'Stop all background terminals',
        'Stop the turn in Ari to end its background work.',
      ],
      [
        'prompts',
        'Run or save reusable prompts',
        'Codex prompts are only available in its terminal app.',
      ],
    ] as const
  ).map(([name, description, reason]) => ({
    name,
    description,
    argumentHint: null,
    run: 'unsupported' as const,
    reason,
  })),
]

/**
 * Codex's commands in Ari, plus its enabled skills. Skills keep the `$name`
 * spelling Codex mentions them by, which is also how its ACP adapter lists
 * them, so `/$name request` means the same on either transport.
 */
export function codexSlashCommands(skills: readonly CodexSkill[] = []): SlashCommand[] {
  const out: SlashCommand[] = CODEX_COMMANDS.filter(
    (command) => !isHiddenSlashCommand(command.name),
  ).map((command) => ({ ...command, source: 'builtin' as const }))
  const taken = new Set(out.map((command) => command.name.toLowerCase()))
  for (const skill of skills) {
    const bare = commandName(skill.name).replace(/^\$/, '')
    const name = `$${bare}`
    if (bare.length === 0 || skill.enabled === false || taken.has(name.toLowerCase())) continue
    taken.add(name.toLowerCase())
    out.push({
      name,
      description: text(skill.shortDescription || skill.description, 2_000),
      argumentHint: '[request]',
      source: 'skill',
      run: 'rpc',
    })
  }
  return out
}

/**
 * A provider's advertised list plus the client-side commands it leaves out.
 * Codex's ACP adapter advertises only what it handles itself; the TUI's other
 * commands (`/model`, `/diff`, ...) would otherwise reach the model as plain
 * text, so they stay listed as unsupported with what to use instead.
 */
export function withClientSideCommands(
  kind: string,
  advertised: readonly SlashCommand[],
): SlashCommand[] {
  if (kind !== 'codex') return [...advertised]
  const taken = new Set(advertised.map((command) => command.name.toLowerCase()))
  const extra = codexSlashCommands().filter(
    (command) => command.run === 'unsupported' && !taken.has(command.name.toLowerCase()),
  )
  return [...advertised, ...extra]
}

/** First entry per name wins; providers can list a name twice (Claude does). */
function dedupe(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>()
  return commands.filter((command) => {
    const key = command.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

import { z } from 'zod'

/**
 * Slash commands a session's provider offers, normalized across transports.
 * Providers advertise their own lists (ACP `available_commands_update`, the
 * Claude SDK's `supportedCommands()`); Codex's app-server has no list, so Ari
 * maps the TUI's commands it can honor onto app-server methods itself.
 */

/** Where a command comes from, for grouping and badges in the "/" menu. */
export const slashCommandSourceSchema = z.enum([
  'builtin',
  'project',
  'user',
  'skill',
  'mcp',
  'ari',
])
export type SlashCommandSource = z.infer<typeof slashCommandSourceSchema>

/**
 * How Ari runs a command once it is sent.
 * - `prompt-text`: the turn prompt is the command, verbatim; the provider expands it.
 * - `rpc`: Ari calls the provider's own method for it (Codex app-server).
 * - `unsupported`: listed so the user learns why it does nothing here; never sent.
 */
export const slashCommandRunSchema = z.enum(['prompt-text', 'rpc', 'unsupported'])
export type SlashCommandRun = z.infer<typeof slashCommandRunSchema>

export const slashCommandSchema = z.object({
  /** Without the leading slash. Ari's own commands may hold a space (`ari theme`). */
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  /** e.g. `<file>` or `[objective|clear|pause|resume]`; null when it takes none. */
  argumentHint: z.string().max(500).nullable(),
  source: slashCommandSourceSchema,
  run: slashCommandRunSchema,
  /** Why Ari cannot run it, or which Ari feature does the same; set with `unsupported`. */
  reason: z.string().max(500).optional(),
  /** Other names that run the same command (Claude's `/cost` for `/usage`). */
  aliases: z.array(z.string().min(1).max(200)).max(20).optional(),
})
export type SlashCommand = z.infer<typeof slashCommandSchema>

/** What a provider command list is cached as, per session. */
export const slashCommandListSchema = z.array(slashCommandSchema).max(1_000)

/** Ari's own commands, offered in every session. The engine expands them. */
export const ARI_SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  {
    name: 'ari theme',
    description: 'Design a custom theme for Ari',
    argumentHint: '<design idea>',
    source: 'ari',
    run: 'prompt-text',
  },
])

/**
 * Commands that only make sense in a provider's own terminal UI: they drive
 * the terminal (vim keys, colors, status line, key bindings), quit the CLI,
 * or install terminal integrations. Ari hides them from the menu and never
 * sends them. Keep every provider's TUI-only names here, in one place.
 * Claude also reports its own terminal-bound set at startup
 * (`terminal_slash_commands`); those are hidden in addition to this list.
 */
export const TUI_ONLY_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  // Leaving or redrawing the terminal app.
  'quit',
  'exit',
  'clear-screen',
  // Terminal look and input handling.
  'theme',
  'vim',
  'keymap',
  'keybindings',
  'terminal-setup',
  'statusline',
  'title',
  'color',
  'focus',
  'raw',
  'pets',
  'voice',
  // Terminal integrations and installers.
  'ide',
  'install-github-app',
  'install-slack-app',
  'mobile',
  'desktop',
  'app',
  'daemon',
  'upgrade',
  'release-notes',
  'privacy-settings',
  // Diagnostics about the CLI process itself.
  'heapdump',
  'rollout',
  'debug-config',
  'debug-m-drop',
  'debug-m-update',
  'test-approval',
  // Terminal working directory and sandbox setup.
  'cd',
  'pwd',
  'setup-default-sandbox',
  'elevate-sandbox',
  'sandbox-add-read-dir',
  // Provider plumbing listed as commands but never typed by a person.
  'workflow-launch-exec',
])

/**
 * True for a provider's built-in command that Ari never shows or sends, given
 * the provider's own extra TUI-only names. Apply it to built-ins only: a
 * user's or project's own command may share a name with a terminal one.
 */
export function isHiddenSlashCommand(name: string, extraHidden?: ReadonlySet<string>): boolean {
  const key = name.toLowerCase()
  // Leading underscores mark a provider's internal commands (`__remote-workflow`).
  return key.startsWith('_') || TUI_ONLY_SLASH_COMMANDS.has(key) || (extraHidden?.has(key) ?? false)
}

/** A leading `/name args` in a message. */
export interface SlashInvocation {
  name: string
  args: string
}

// `$name` is how Codex names skills; its ACP adapter lists them that way.
const SLASH_RE = /^\/(\$?[A-Za-z0-9][\w:.@-]*)(?:[ \t]+([\s\S]*))?$/
const ARI_RE = /^\/ari[ \t]+theme(?:[ \t]+([\s\S]*))?$/i

/**
 * Reads a message that is a slash command: `/name` at the very start, then
 * arguments after a space. Text that merely contains a slash (`/usr/bin`,
 * `see /docs`) is not one. Ari's `/ari theme` comes back as `ari theme`.
 */
export function parseSlashCommand(text: string): SlashInvocation | null {
  const trimmed = text.replace(/^\s+/, '').replace(/\s+$/, '')
  const ari = ARI_RE.exec(trimmed)
  if (ari) return { name: 'ari theme', args: (ari[1] ?? '').trim() }
  const match = SLASH_RE.exec(trimmed)
  if (!match?.[1]) return null
  return { name: match[1], args: (match[2] ?? '').trim() }
}

/** Looks a typed name up in a list, ignoring case. */
export function findSlashCommand(
  commands: readonly SlashCommand[],
  name: string,
): SlashCommand | undefined {
  const key = name.toLowerCase()
  return (
    commands.find((command) => command.name.toLowerCase() === key) ??
    commands.find((command) => command.aliases?.some((alias) => alias.toLowerCase() === key))
  )
}

const SOURCE_ORDER: Record<SlashCommandSource, number> = {
  ari: 0,
  project: 1,
  user: 2,
  skill: 3,
  mcp: 4,
  builtin: 5,
}

/**
 * The "/" menu's rows for what is typed after the slash: hidden commands
 * dropped, then name-prefix matches before name-substring matches before
 * description matches. Within a rank, runnable commands come before disabled
 * ones, then by source, then by name.
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  limit = 200,
): SlashCommand[] {
  const q = query.trim().toLowerCase()
  const seen = new Set<string>()
  const ranked: { command: SlashCommand; rank: number }[] = []
  for (const command of commands) {
    const key = command.name.toLowerCase()
    if (seen.has(key) || (command.source === 'builtin' && isHiddenSlashCommand(key))) continue
    seen.add(key)
    let rank: number
    if (q.length === 0 || key.startsWith(q)) rank = 0
    else if (
      key.split(/[\s:_-]/).some((word) => word.startsWith(q)) ||
      command.aliases?.some((alias) => alias.toLowerCase().startsWith(q))
    )
      rank = 1
    else if (key.includes(q)) rank = 2
    else if (command.description.toLowerCase().includes(q)) rank = 3
    else continue
    ranked.push({ command, rank })
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(a.command.run === 'unsupported') - Number(b.command.run === 'unsupported') ||
      SOURCE_ORDER[a.command.source] - SOURCE_ORDER[b.command.source] ||
      a.command.name.localeCompare(b.command.name),
  )
  return ranked.slice(0, limit).map((entry) => entry.command)
}

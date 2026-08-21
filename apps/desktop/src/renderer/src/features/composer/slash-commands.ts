/** A slash command surfaced in the composer popup (M6.5). */
export interface SlashCommand {
  /** Command name without the leading `/`. */
  name: string
  /** One-line description rendered in the popup row. */
  description: string
  /** Optional argument hint, e.g. `[name]`. */
  argsHint?: string
}

/** Built-in command registry. Order is the display order for an empty query. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'model', description: 'Switch the model for this session', argsHint: '[name]' },
  { name: 'mode', description: 'Set the permission mode', argsHint: '[ask|edits|full]' },
  { name: 'clear', description: 'Clear the conversation and start fresh' },
  { name: 'help', description: 'List available commands' },
]

/**
 * Pure matcher behind the slash-command popup. Accepts raw composer text
 * (`/mo`, `mo`, `/mode ask`) and returns the commands whose name starts with
 * the query — an exact name match sorts first, remaining matches keep
 * registry order. Empty query returns the whole registry.
 */
export function matchSlash(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const query = input.trim().replace(/^\//, '').split(/\s/, 1)[0]?.toLowerCase() ?? ''
  if (query === '') return [...commands]
  const matches = commands.filter((command) => command.name.toLowerCase().startsWith(query))
  return matches.sort((a, b) => {
    if (a.name.toLowerCase() === query) return -1
    if (b.name.toLowerCase() === query) return 1
    return 0
  })
}

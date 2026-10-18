import type { ProviderLoginMethod } from '@ari/contracts/rpc'

/**
 * Renders an agent-supplied login into one command line for Ari's terminal
 * pane. The pane runs an interactive shell (PowerShell on Windows, zsh/bash
 * elsewhere), so the argv has to be re-quoted for that shell rather than
 * spawned directly.
 *
 * Quoting is not cosmetic here: `command` and `args` arrive from the ACP agent
 * over stdio, so an unquoted join would let a crafted adapter response run
 * arbitrary shell. Every part is quoted literally — no interpolation survives.
 */

/** POSIX single-quoting: literal throughout, `'` closes and re-opens the quote. */
function quotePosix(part: string): string {
  return `'${part.replaceAll("'", `'\\''`)}'`
}

/**
 * PowerShell single-quoting: literal throughout, a quote escapes by doubling.
 * PowerShell also ends a string at the typographic quotes U+2018 to U+201B,
 * which a folder or user name can contain, so those are doubled too.
 */
function quotePowerShell(part: string): string {
  return `'${part.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`
}

/**
 * `env` sets variables for the command (the home of the account being signed
 * in). In PowerShell they stay set for the rest of that terminal tab, which is
 * opened for this sign-in alone. Names that are not plain identifiers are
 * dropped rather than quoted: a name cannot be quoted in either shell.
 */
export function loginCommandLine(
  login: Pick<ProviderLoginMethod, 'command' | 'args'>,
  platform: string,
  env: Record<string, string> = {},
): string {
  const isWindows = platform === 'win32'
  const quote = isWindows ? quotePowerShell : quotePosix
  const parts = [login.command, ...login.args].map(quote)
  const vars = Object.entries(env).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  if (isWindows) {
    // A quoted string is data to PowerShell until `&` makes it the command.
    const set = vars.map(([name, value]) => `$env:${name} = ${quote(value)}; `).join('')
    return `${set}& ${parts.join(' ')}`
  }
  return [...vars.map(([name, value]) => `${name}=${quote(value)}`), ...parts].join(' ')
}

/** Terminal tab title for a login, e.g. "Claude Subscription sign-in". */
export function loginTabTitle(login: Pick<ProviderLoginMethod, 'name'>): string {
  return `${login.name} sign-in`
}

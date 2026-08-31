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

/** PowerShell single-quoting: literal throughout, `'` escapes by doubling. */
function quotePowerShell(part: string): string {
  return `'${part.replaceAll("'", "''")}'`
}

export function loginCommandLine(
  login: Pick<ProviderLoginMethod, 'command' | 'args'>,
  platform: string,
): string {
  const isWindows = platform === 'win32'
  const quote = isWindows ? quotePowerShell : quotePosix
  const parts = [login.command, ...login.args].map(quote)
  // A quoted string is data to PowerShell until `&` makes it the command.
  return isWindows ? `& ${parts.join(' ')}` : parts.join(' ')
}

/** Terminal tab title for a login, e.g. "Claude Subscription sign-in". */
export function loginTabTitle(login: Pick<ProviderLoginMethod, 'name'>): string {
  return `${login.name} sign-in`
}

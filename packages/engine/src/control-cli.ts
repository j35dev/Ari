import type { ApprovalOption } from '@ari/contracts/common'

/**
 * `ari` subcommands that either only read, or act inside limits the control
 * service enforces on its own (scope, depth, concurrency, the delegation
 * approval). `integrate` writes into the parent's workspace, `destroy` deletes
 * sessions and `skill install` writes user configuration, so those keep their
 * permission prompt.
 */
const TOP_LEVEL = new Set(['env', 'agents', 'providers', '--skill'])
const SESSION = new Set([
  'get',
  'children',
  'status',
  'spawn',
  'prompt',
  'message',
  'read',
  'wait',
  'stop',
  'diff',
])
const COMMAND_WORDS = new Set(['ari', 'ari.cmd', '$ARI_CLI', '"$ARI_CLI"'])
/** What agents habitually append to keep output short; neither can do harm. */
const OUTPUT_TRIM = / \| (?:head|tail)(?: -n)?(?: -?\d+)?$/

/** Splits one simple command into words, or null when it is not simple. */
function words(segment: string): string[] | null {
  const out: string[] = []
  let current: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string
    // The shell expands and substitutes everywhere except inside single quotes.
    if ((char === '$' || char === '`') && quote !== "'") return null
    if (quote !== null) {
      const next = segment[i + 1]
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && (next === '"' || next === '\\')) {
        current += next
        i++
      } else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current ??= ''
    } else if (char === ' ') {
      if (current !== null) out.push(current)
      current = null
    } else if (/[\w./:=@,+%-]/.test(char)) current = (current ?? '') + char
    else return null
  }
  if (quote !== null) return null
  if (current !== null) out.push(current)
  return out
}

function isSafeInvocation(segment: string): boolean {
  const trimmed = segment.trim().replace(OUTPUT_TRIM, '').replace(/ 2>&1$/, '')
  const space = trimmed.indexOf(' ')
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  if (!COMMAND_WORDS.has(head)) return false
  const args = words(space === -1 ? '' : trimmed.slice(space + 1))
  if (args === null) return false
  const [first, second] = args
  if (first === undefined) return false
  if (TOP_LEVEL.has(first)) return true
  if (first === 'session') return second !== undefined && SESSION.has(second)
  return first === 'parent' && second === 'message'
}

/**
 * True when a shell command line is nothing but safe `ari` invocations,
 * optionally chained with `&&` or `||`. Anything it cannot fully account for
 * (redirections, pipes to other programs, substitutions, a second command) is
 * not safe, so the user is asked as usual.
 */
export function isSafeControlCommand(command: string): boolean {
  if (command.length === 0 || command.length > 70_000 || /[\r\n]/.test(command)) return false
  return command.split(/ (?:&&|\|\|) /).every(isSafeInvocation)
}

/**
 * The option to answer a permission request with when it asks to run a safe
 * `ari` command through a POSIX shell tool, or null to leave it to the user.
 * Only the `Bash` tool qualifies: it resolves `ari` through PATH, where Ari's
 * launcher comes first, whereas `cmd.exe` would run an `ari.cmd` from the
 * project folder.
 */
export function controlCliApproval(request: {
  toolName: string
  summaryJson: string
  options: readonly ApprovalOption[]
}): string | null {
  if (request.toolName !== 'Bash') return null
  let command: unknown
  try {
    command = (JSON.parse(request.summaryJson) as { command?: unknown }).command
  } catch {
    return null
  }
  if (typeof command !== 'string' || !isSafeControlCommand(command)) return null
  return request.options.find((option) => option.kind === 'allow_once')?.optionId ?? null
}

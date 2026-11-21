import type { DriverKind } from '@ari/contracts/common'
import type { SessionCommands } from '@ari/contracts/rpc'
import {
  ARI_SLASH_COMMANDS,
  TUI_ONLY_SLASH_COMMANDS,
  findSlashCommand,
  parseSlashCommand,
  type SlashCommand,
  type SlashInvocation,
} from '@ari/contracts/slash-commands'
import { withClientSideCommands } from '@ari/providers/slash-commands'

/**
 * The last command list each session's provider reported, kept in memory so
 * the composer's "/" menu opens at once. A list belongs to the provider that
 * reported it: after a provider switch the session has none until the new
 * provider reports one. Lists also seed new sessions of the same provider in
 * the same folder, which see the same commands.
 */
export class SessionCommandCache {
  readonly #bySession = new Map<
    string,
    { driverKind: DriverKind | null; commands: SlashCommand[] }
  >()
  readonly #byScope = new Map<string, SlashCommand[]>()

  record(
    sessionId: string,
    driverKind: DriverKind | null,
    workspace: string | null,
    commands: readonly SlashCommand[],
  ): void {
    // A report between turns names no provider; it is the one already cached.
    const kind = driverKind ?? this.#bySession.get(sessionId)?.driverKind ?? null
    const list = [...commands]
    this.#bySession.set(sessionId, { driverKind: kind, commands: list })
    if (kind !== null && workspace !== null) this.#byScope.set(scopeKey(kind, workspace), list)
  }

  get(sessionId: string, driverKind: DriverKind): SlashCommand[] | null {
    const entry = this.#bySession.get(sessionId)
    if (!entry || (entry.driverKind !== null && entry.driverKind !== driverKind)) return null
    return entry.commands
  }

  forScope(driverKind: DriverKind, workspace: string | null): SlashCommand[] | null {
    return workspace === null ? null : (this.#byScope.get(scopeKey(driverKind, workspace)) ?? null)
  }

  forget(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }
}

function scopeKey(kind: DriverKind, workspace: string): string {
  return `${kind}\u0000${workspace.toLowerCase()}`
}

/** Everything the "/" menu lists for a provider: Ari's own commands first. */
export function menuCommands(
  driverKind: DriverKind,
  providerCommands: readonly SlashCommand[] | null,
): SlashCommand[] {
  return [...ARI_SLASH_COMMANDS, ...withClientSideCommands(driverKind, providerCommands ?? [])]
}

/** What a turn's prompt is, as far as slash commands go. */
export type SlashRouting =
  /** Not a provider command: the prompt goes out the way it always has. */
  | { kind: 'prompt' }
  /** The provider expands it: send exactly what was typed, nothing prepended. */
  | { kind: 'verbatim'; invocation: SlashInvocation }
  /** The provider runs it through its own method. */
  | { kind: 'rpc'; invocation: SlashInvocation }
  /** Never sent: it would do nothing useful, or reach the model as plain text. */
  | { kind: 'blocked'; invocation: SlashInvocation; message: string }

const PROVIDER_LABELS: Partial<Record<DriverKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  hermes: 'Hermes',
}

export function providerLabel(kind: DriverKind): string {
  return PROVIDER_LABELS[kind] ?? kind
}

/**
 * Decides how a prompt that starts with `/` runs. Ari's own `/ari theme` is
 * left to the engine's theme expansion. A name the provider's list knows runs
 * as that entry says; a terminal-only name it does not know is blocked rather
 * than handed to the model as text. Anything else is an ordinary prompt.
 */
export function routeSlashCommand(
  prompt: string,
  driverKind: DriverKind,
  providerCommands: readonly SlashCommand[] | null,
): SlashRouting {
  const invocation = parseSlashCommand(prompt)
  if (invocation === null || invocation.name === 'ari theme') return { kind: 'prompt' }
  const label = providerLabel(driverKind)
  const entry = findSlashCommand(
    withClientSideCommands(driverKind, providerCommands ?? []),
    invocation.name,
  )
  if (entry === undefined) {
    if (TUI_ONLY_SLASH_COMMANDS.has(invocation.name.toLowerCase()))
      return {
        kind: 'blocked',
        invocation,
        message: `/${invocation.name} only works in ${label}'s own terminal app, so Ari did not send it.`,
      }
    return { kind: 'prompt' }
  }
  if (entry.run === 'unsupported')
    return {
      kind: 'blocked',
      invocation,
      message:
        `/${invocation.name} isn't available in Ari, so it was not sent. ${entry.reason ?? ''}`.trim(),
    }
  return entry.run === 'rpc' ? { kind: 'rpc', invocation } : { kind: 'verbatim', invocation }
}

/** The `session.commands` answer for a provider list (null when none is known yet). */
export function sessionCommands(
  driverKind: DriverKind,
  providerCommands: readonly SlashCommand[] | null,
  discoverable: boolean,
): SessionCommands {
  const label = providerLabel(driverKind)
  return {
    commands: menuCommands(driverKind, providerCommands),
    driverKind,
    complete: providerCommands !== null,
    note:
      providerCommands !== null
        ? providerCommands.length === 0
          ? `${label} reported no commands of its own.`
          : null
        : discoverable
          ? `Could not read ${label}'s commands right now.`
          : `${label}'s own commands appear here after its first reply in this chat.`,
  }
}

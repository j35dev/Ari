import type { DriverKind } from '@ari/contracts/common'

const DRIVER_LABEL: Record<DriverKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  hermes: 'Hermes',
  'ari-core': 'Ari Core',
}

/** Display name for a driver kind; unknown kinds keep their raw id. */
export function driverLabel(kind: string): string {
  return DRIVER_LABEL[kind as DriverKind] ?? kind
}

/**
 * Single-letter identity for an agent. Letters stay readable at chip size
 * without vendor logos; unknown kinds use the first character.
 */
export function agentMark(kind: string): string {
  if (kind === 'ari-core' || kind === 'Ari Core') return 'A'
  if (kind === 'codex' || kind === 'Codex') return 'X'
  const ch = kind.trim().charAt(0)
  return ch === '' ? '?' : ch.toUpperCase()
}

/** Map a picker group label back to a driver kind for the letter mark. */
export function kindFromGroup(group: string): string {
  if (group === 'Ari Core') return 'ari-core'
  return group.toLowerCase()
}

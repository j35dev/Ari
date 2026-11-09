import { rowTurnId } from './groupBlocks'
import type { ProviderSwitch, ProviderSwitchRow, TranscriptRow } from './types'

/** A switch during a turn belongs after that turn's output, before the next prompt. */
export function insertProviderSwitchRows(
  rows: TranscriptRow[],
  switches: readonly ProviderSwitch[],
): TranscriptRow[] {
  if (switches.length === 0) return rows
  const groups = new Map<number, ProviderSwitchRow[]>()
  for (const change of switches) {
    let target =
      change.afterMessageId === null && change.afterTurnId === null ? -1 : rows.length - 1
    let messageTarget: number | null = null
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!
      if (row.kind === 'delegation' || row.kind === 'provider-switch') continue
      if (change.afterTurnId !== null && rowTurnId(row) === change.afterTurnId) {
        target = i
        messageTarget = null
        break
      }
      const keys = row.kind === 'tool-group' ? row.blocks.map((block) => block.key) : [row.key]
      if (
        messageTarget === null &&
        change.afterMessageId !== null &&
        keys.some((key) => key.startsWith(`${change.afterMessageId}#`))
      )
        messageTarget = i
    }
    if (messageTarget !== null) target = messageTarget
    // Delegation rows follow their owning transcript row, including when a
    // final activity burst is the turn's last output.
    while (rows[target + 1]?.kind === 'delegation') target++
    const group = groups.get(target) ?? []
    group.push({ kind: 'provider-switch', key: `provider-switch:${change.seq}`, switch: change })
    groups.set(target, group)
  }
  return [
    ...(groups.get(-1) ?? []),
    ...rows.flatMap((row, index) => [row, ...(groups.get(index) ?? [])]),
  ]
}

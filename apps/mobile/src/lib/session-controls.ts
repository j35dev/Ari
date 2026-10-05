import type { PermissionMode } from '@ari/contracts/common'
import type { RemoteEffortOption, RemoteModelCatalog } from '@ari/contracts/remote'

export interface ModeChoice {
  value: PermissionMode
  label: string
  description: string
}

const ARI_MODES: readonly ModeChoice[] = [
  { value: 'ask', label: 'Ask', description: 'Confirm every edit and command' },
  { value: 'allow-edits', label: 'Edits', description: 'Auto-approve edits; ask before commands' },
  { value: 'full', label: 'Full auto', description: 'Approve everything automatically' },
]

function provider(
  catalog: RemoteModelCatalog | null,
  driverKind: string,
): RemoteModelCatalog['providers'][number] | undefined {
  return catalog?.providers.find((entry) => entry.driverKind === driverKind)
}

/** The provider's reasoning levels, or `null` when the desktop is too old to report them. */
export function effortChoices(
  catalog: RemoteModelCatalog | null,
  driverKind: string,
): RemoteEffortOption[] | null {
  return provider(catalog, driverKind)?.efforts ?? null
}

/** The saved level, else the one the agent is using, else the first, as the desktop shows it. */
export function effortLabel(options: readonly RemoteEffortOption[], effort: string | null): string {
  if (effort !== null) return options.find((option) => option.id === effort)?.label ?? 'Default'
  return (options.find((option) => option.current === true) ?? options[0])?.label ?? 'Default'
}

/**
 * One row per Ari mode, named as the provider names it where it has a name.
 * `null` when the desktop reports no mode list, which also means it would
 * refuse a mode sent from a phone.
 */
export function modeChoices(
  catalog: RemoteModelCatalog | null,
  driverKind: string,
): ModeChoice[] | null {
  const native = provider(catalog, driverKind)?.modes
  if (native === undefined) return null
  return ARI_MODES.map((mode) => {
    const named = native.filter((option) => option.ariMode === mode.value)
    const chosen = named.find((option) => option.current === true) ?? named[0]
    return chosen === undefined
      ? mode
      : {
          value: mode.value,
          label: chosen.label,
          description: chosen.description ?? mode.description,
        }
  })
}

export function modeLabel(choices: readonly ModeChoice[], mode: PermissionMode): string {
  return [...choices, ...ARI_MODES].find((choice) => choice.value === mode)?.label ?? mode
}

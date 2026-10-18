import type { DriverKind } from '@ari/contracts/common'
import { Switch } from '@ari/ui/switch'
import { driverLabel } from '../composer/agent-mark'
import { ProviderLogo } from '../composer/provider-logo'
import { StatusDot } from './StatusDot'
import type { ProviderStatus } from './provider-status'

export interface ProviderListRow {
  kind: DriverKind
  status: ProviderStatus
  /** Short version for the row, or null when unknown or not applicable. */
  version: string | null
  /** Null for a provider that cannot be turned off (Ari Core). */
  enabled: boolean | null
}

export interface ProviderListProps {
  rows: ProviderListRow[]
  selected: DriverKind
  onSelect: (kind: DriverKind) => void
  onEnabledChange: (kind: DriverKind, enabled: boolean) => void
}

/** Every provider with its state in one line and its on/off switch. */
export function ProviderList({ rows, selected, onSelect, onEnabledChange }: ProviderListProps) {
  return (
    <ul aria-label="Providers" className="flex flex-col">
      {rows.map((row) => {
        const name = driverLabel(row.kind)
        const isSelected = row.kind === selected
        return (
          <li
            key={row.kind}
            className={`flex items-center gap-2 border-b border-border/60 pr-3 transition-colors last:border-b-0 ${
              isSelected ? 'bg-surface-2' : 'hover:bg-surface-2/50'
            }`}
          >
            <button
              type="button"
              aria-label={`${name}, ${row.status.headline}`}
              aria-current={isSelected ? 'true' : undefined}
              onClick={() => onSelect(row.kind)}
              className={`flex min-w-0 flex-1 items-start gap-2.5 py-3 pl-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                row.enabled === false && !isSelected ? 'opacity-60' : ''
              }`}
            >
              <span className="mt-0.5">
                <ProviderLogo kind={row.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{name}</span>
                  {row.version !== null && (
                    <code className="shrink-0 font-mono text-2xs text-fg-subtle">v{row.version}</code>
                  )}
                </span>
                <span className="mt-0.5 flex items-start gap-1.5 text-xs text-fg-muted">
                  <StatusDot tone={row.status.tone} />
                  <span className="truncate">{row.status.headline}</span>
                </span>
              </span>
            </button>
            {row.enabled !== null && (
              <Switch
                checked={row.enabled}
                onCheckedChange={(checked) => onEnabledChange(row.kind, checked)}
                aria-label={`Enable ${name}`}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

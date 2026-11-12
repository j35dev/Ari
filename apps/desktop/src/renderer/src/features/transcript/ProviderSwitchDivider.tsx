import { modelsFor, resolveOfferedModel } from '@ari/providers/catalogs'
import { driverLabel } from '../composer/agent-mark'
import type { ProviderSwitch } from './types'

export function ProviderSwitchDivider({
  change,
  modelLabel,
}: {
  change: ProviderSwitch
  modelLabel?: string
}) {
  const models = modelsFor(change.driverKind)
  const id = change.modelId === null ? null : resolveOfferedModel(change.modelId, models)
  const label =
    modelLabel ?? models.find((model) => model.id === id)?.label ?? change.modelId ?? 'Default'
  return (
    <div role="separator" className="my-5 flex items-center gap-4 text-xs text-fg-subtle">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span>
        Switched to {driverLabel(change.driverKind)} · {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

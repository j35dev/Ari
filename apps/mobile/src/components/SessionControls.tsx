import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Gauge, PencilLine, ShieldCheck, Zap } from 'lucide-react'
import type { PermissionMode } from '@ari/contracts/common'
import type { RemoteEffortOption } from '@ari/contracts/remote'
import { useApp } from '../lib/app-state'
import { effortChoices, effortLabel, modeChoices, modeLabel } from '../lib/session-controls'
import { OptionSheet } from './OptionSheet'

const modeIcons = { ask: ShieldCheck, 'allow-edits': PencilLine, full: Zap } as const

/**
 * The composer's model, effort and permission chips. Effort and mode appear
 * only when the desktop reports their options, which is also when it accepts
 * them from a phone.
 */
export function SessionControls({
  driverKind,
  modelId,
  modelLabel,
  effort,
  permissionMode,
  running = false,
  disabled = false,
  modelDisabled = false,
  onPickModel,
  onEffort,
  onMode,
}: {
  driverKind: string
  modelId: string
  modelLabel: string | null
  effort: string | null
  permissionMode: PermissionMode
  running?: boolean
  disabled?: boolean
  modelDisabled?: boolean
  onPickModel: () => void
  onEffort: (effort: string) => void
  onMode: (mode: PermissionMode) => void
}): ReactNode {
  const app = useApp()
  const [open, setOpen] = useState<'effort' | 'mode' | null>(null)
  const [specific, setSpecific] = useState<RemoteEffortOption[] | null>(null)
  const reported = effortChoices(app.catalog, driverKind)
  const modes = modeChoices(app.catalog, driverKind)
  const efforts = specific ?? reported ?? []
  const session = app.session
  useEffect(() => {
    setSpecific(null)
  }, [driverKind, modelId])
  useEffect(() => {
    if (open !== 'effort' || session === null || !session.supports('models.efforts')) return
    let cancelled = false
    void session
      .query<{ efforts: RemoteEffortOption[] }>('models.efforts', {
        driverKind,
        ...(modelId ? { modelId } : {}),
      })
      .then((result) => {
        if (!cancelled && result.efforts.length > 0) setSpecific(result.efforts)
      })
      // The provider's own list is already showing; a failed lookup changes nothing.
      .catch((error: unknown) => console.warn('Could not read this model’s effort levels', error))
    return () => {
      cancelled = true
    }
  }, [open, session, driverKind, modelId])
  const note = running ? 'Applies to the next turn.' : undefined
  const ModeIcon = modeIcons[permissionMode]
  return (
    <>
      <button
        type="button"
        className="control-chip min-w-0"
        aria-label={`Model: ${modelLabel ?? 'Connecting…'}`}
        disabled={disabled || modelDisabled}
        onClick={onPickModel}
      >
        <span className="truncate">{modelLabel ?? 'Connecting…'}</span>
        <ChevronDown size={13} className="shrink-0" />
      </button>
      {reported !== null && efforts.length > 0 && (
        <button
          type="button"
          className="control-chip shrink-0"
          aria-label={`Effort: ${effortLabel(efforts, effort)}`}
          disabled={disabled}
          onClick={() => setOpen('effort')}
        >
          <Gauge size={14} className="shrink-0" />
          {effortLabel(efforts, effort)}
        </button>
      )}
      {modes !== null && (
        <button
          type="button"
          className={`control-chip shrink-0 ${permissionMode === 'full' ? 'text-warning' : ''}`}
          aria-label={`Permissions: ${modeLabel(modes, permissionMode)}`}
          disabled={disabled}
          onClick={() => setOpen('mode')}
        >
          <ModeIcon size={14} className="shrink-0" />
          {modeLabel(modes, permissionMode)}
        </button>
      )}
      {open === 'effort' && (
        <OptionSheet
          title="Effort"
          options={efforts.map((option) => ({
            value: option.id,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          }))}
          selected={
            effort ?? (efforts.find((option) => option.current === true) ?? efforts[0])?.id ?? null
          }
          {...(note === undefined ? {} : { note })}
          onSelect={onEffort}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'mode' && modes !== null && (
        <OptionSheet
          title="Permissions"
          options={modes}
          selected={permissionMode}
          {...(note === undefined ? {} : { note })}
          onSelect={onMode}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

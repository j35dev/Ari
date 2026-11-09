import { useState } from 'react'
import type { Settings } from '@ari/contracts/settings'
import { ModelSelector } from '../composer/ModelSelector'
import { loadLastPick } from '../composer/last-pick'
import { EffortChip, PermissionModeChip } from '../session/SessionView'
import { SettingsPage } from './SettingsPage'
import { SettingsSection } from './SettingsSection'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'

export function AriaSettings() {
  const { settings, update } = useEngineSettings()
  const [lastPick] = useState(loadLastPick)
  const [error, setError] = useState<string | null>(null)
  const pick: NonNullable<Settings['aria']> = settings?.aria ?? {
    driverKind: lastPick?.driverKind ?? settings?.sessions.defaultDriverKind ?? 'ari-core',
    modelId: lastPick?.modelId ?? null,
    effort: lastPick?.effort ?? null,
    permissionMode: settings?.sessions.defaultPermissionMode ?? 'ask',
  }
  const persist = (next: Settings['aria']): void => {
    setError(null)
    void update({ aria: next }).catch(() => setError('Could not save Aria settings.'))
  }
  return (
    <SettingsPage title="Aria" description="The agent you talk to across all your projects.">
      <SettingsSection
        title="New topics"
        description="These choices apply when Aria starts a new topic."
        action={
          <button
            type="button"
            disabled={settings?.aria == null}
            onClick={() => persist(null)}
            className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-40"
          >
            Use session defaults
          </button>
        }
      >
        <SettingsRow
          label="Provider and model"
          hint={settings?.aria == null ? 'Using your default new-session choices.' : undefined}
        >
          <ModelSelector
            driverKind={pick.driverKind}
            modelId={pick.modelId}
            onChange={(next) => persist({ ...pick, ...next, effort: null })}
          />
        </SettingsRow>
        <SettingsRow label="Effort">
          <EffortChip
            driverKind={pick.driverKind}
            modelId={pick.modelId}
            effort={pick.effort}
            onChange={(effort) => persist({ ...pick, effort })}
          />
        </SettingsRow>
        <SettingsRow label="Permission">
          <PermissionModeChip
            driverKind={pick.driverKind}
            mode={pick.permissionMode}
            onChange={(permissionMode) => persist({ ...pick, permissionMode })}
          />
        </SettingsRow>
      </SettingsSection>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </SettingsPage>
  )
}

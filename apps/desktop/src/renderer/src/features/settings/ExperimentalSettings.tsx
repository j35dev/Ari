import { useState } from 'react'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { SettingsSection } from './SettingsSection'
import { useEngineSettings } from './useEngineSettings'

export function ExperimentalSettings() {
  const { settings, update } = useEngineSettings()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <SettingsPage
      id="settings-experimental"
      title="Experimental"
      description="Optional features still being refined."
    >
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <SettingsSection title="Experiments">
        <SettingsRow
          label="Aria"
          hint="A shared coordinator chat across your projects. Off by default. Turning it off stops its current turn and keeps your chats, project defaults and shortcuts. Project sessions keep running."
        >
          <Switch
            aria-label="Enable experimental Aria"
            checked={settings?.experimental.ariaEnabled ?? false}
            disabled={!settings || pending}
            onCheckedChange={(ariaEnabled) => {
              setPending(true)
              setError(null)
              void update({ experimental: { ariaEnabled } })
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : String(reason)),
                )
                .finally(() => setPending(false))
            }}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}

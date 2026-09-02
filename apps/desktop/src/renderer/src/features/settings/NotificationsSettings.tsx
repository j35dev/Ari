import { createLogger } from '@ari/shared/logger'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:notifications')

/**
 * Notification settings: audible cues for turn settles. The chime itself is
 * synthesized in the moment feature (`settle-sound.ts`); this page only owns
 * the persisted preference.
 */
export function NotificationsSettings() {
  const { settings, update } = useEngineSettings()
  const settleSound = settings?.notifications.settleSound ?? true

  const handleSettleSoundChange = (checked: boolean) => {
    void update({ notifications: { settleSound: checked } }).catch((error: unknown) => {
      log.warn('failed to persist settle sound preference', { error })
    })
  }

  return (
    <SettingsPage title="Notifications" description="How Ari signals that a turn finished.">
      <SettingsRow
        label="Completion sound"
        hint="A soft chime when the agent finishes a turn; failures get a lower tone."
      >
        <Switch
          checked={settleSound}
          onCheckedChange={handleSettleSoundChange}
          aria-label="Completion sound"
        />
      </SettingsRow>
    </SettingsPage>
  )
}

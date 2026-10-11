import { createLogger } from '@ari/shared/logger'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:notifications')

/**
 * Notification settings: how a turn settling reaches the user. The chime is
 * synthesized in the moment feature (`settle-sound.ts`) and the desktop
 * notification is raised by the main process; this page only owns the
 * persisted preferences.
 */
export function NotificationsSettings() {
  const { settings, update } = useEngineSettings()
  const settleSound = settings?.notifications.settleSound ?? true
  const desktop = settings?.notifications.desktop ?? true

  const handleSettleSoundChange = (checked: boolean) => {
    void update({ notifications: { settleSound: checked } }).catch((error: unknown) => {
      log.warn('failed to persist settle sound preference', { error })
    })
  }

  const handleDesktopChange = (checked: boolean) => {
    void update({ notifications: { desktop: checked } }).catch((error: unknown) => {
      log.warn('failed to persist desktop notification preference', { error })
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
      <SettingsRow
        label="Desktop notifications"
        hint="While Ari is in the background, notify when any session finishes, fails, or is waiting on you. Click one to open that session."
      >
        <Switch
          checked={desktop}
          onCheckedChange={handleDesktopChange}
          aria-label="Desktop notifications"
        />
      </SettingsRow>
    </SettingsPage>
  )
}

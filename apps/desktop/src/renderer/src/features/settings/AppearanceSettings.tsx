import { createLogger } from '@ari/shared/logger'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:appearance')

/**
 * Appearance settings: Ari ships one designed appearance (comet glass), so
 * there are no theme pickers to maintain. When themes return (M1.2 endgame)
 * this page grows the picker back.
 */
export function AppearanceSettings() {
  const { settings, update } = useEngineSettings()
  const reducedMotion = settings?.appearance.reducedMotion ?? false

  const handleReducedMotionChange = (checked: boolean) => {
    void update({ appearance: { reducedMotion: checked } }).catch((error: unknown) => {
      log.warn('failed to persist reduced motion', { error })
    })
  }

  return (
    <SettingsPage title="Appearance">
      <SettingsRow
        label="Theme"
        hint="A single frosted dark chrome theme tuned for contrast."
      >
        <span className="rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs text-fg-muted">
          Comet glass
        </span>
      </SettingsRow>
      <SettingsRow label="Reduce motion" hint="Minimize animations throughout the app.">
        <Switch
          checked={reducedMotion}
          onCheckedChange={handleReducedMotionChange}
          aria-label="Reduce motion"
        />
      </SettingsRow>
    </SettingsPage>
  )
}

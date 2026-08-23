import { createLogger } from '@ari/shared/logger'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
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
    <SettingsPage
      title="Appearance"
      description="One look, designed — frosted dark chrome over your desktop."
    >
      <section aria-labelledby="appearance-theme-heading" className="space-y-3">
        <h2 id="appearance-theme-heading" className="text-sm font-medium">
          Theme
        </h2>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface-1 p-3">
          <div className="space-y-0.5">
            <p className="text-sm text-fg">Comet glass</p>
            <p className="text-xs text-fg-muted">
              A single frosted dark theme tuned for contrast. Alternate themes may return later.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="appearance-motion-heading" className="space-y-3">
        <h2 id="appearance-motion-heading" className="text-sm font-medium">
          Motion
        </h2>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface-1 p-3">
          <div className="space-y-0.5">
            <p className="text-sm text-fg">Reduce motion</p>
            <p className="text-xs text-fg-muted">Minimize animations throughout the app.</p>
          </div>
          <Switch
            checked={reducedMotion}
            onCheckedChange={handleReducedMotionChange}
            aria-label="Reduce motion"
          />
        </div>
      </section>
    </SettingsPage>
  )
}

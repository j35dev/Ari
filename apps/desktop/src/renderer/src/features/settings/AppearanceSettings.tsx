import { useState } from 'react'
import { THEMES, useTheme } from '@ari/ui/theme-provider'
import type { ThemeId } from '@ari/ui/theme-provider'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'

const REDUCED_MOTION_KEY = 'ari.reducedMotion'

function readReducedMotion(): boolean {
  try {
    return localStorage.getItem(REDUCED_MOTION_KEY) === 'true'
  } catch {
    // storage unavailable — default to motion enabled
    return false
  }
}

interface ThemeCardProps {
  id: ThemeId
  label: string
  active: boolean
  onSelect: (id: ThemeId) => void
}

/**
 * One theme preview card. Scoping `data-theme` to the card makes that theme's
 * token overrides cascade locally, so the swatch bars render its real colors
 * regardless of the active document theme.
 */
function ThemeCard({ id, label, active, onSelect }: ThemeCardProps) {
  return (
    <button
      type="button"
      data-theme={id}
      aria-pressed={active}
      onClick={() => onSelect(id)}
      className={[
        'rounded-md border p-2 text-left transition-colors',
        active
          ? 'border-accent ring-2 ring-accent-ring'
          : 'border-border hover:border-border-strong',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="block overflow-hidden rounded-sm border border-border"
        style={{ background: 'var(--ari-bg)' }}
      >
        <span className="flex h-12 flex-col justify-end gap-1 p-1.5">
          <span className="h-2.5 rounded-sm" style={{ background: 'var(--ari-surface-2)' }} />
          <span className="h-2.5 rounded-sm" style={{ background: 'var(--ari-accent)' }} />
        </span>
      </span>
      <span className="mt-1.5 block text-sm text-fg">{label}</span>
    </button>
  )
}

/** Appearance settings page: live theme previews, reduced motion, density note. */
export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [reducedMotion, setReducedMotion] = useState<boolean>(readReducedMotion)

  const handleReducedMotionChange = (checked: boolean) => {
    setReducedMotion(checked)
    try {
      localStorage.setItem(REDUCED_MOTION_KEY, String(checked))
    } catch {
      // non-fatal: preference simply won't persist
    }
  }

  return (
    <SettingsPage
      title="Appearance"
      description="Themes, motion, and density for the Ari workspace."
    >
      <section aria-labelledby="appearance-theme-heading" className="space-y-3">
        <h2 id="appearance-theme-heading" className="text-sm font-medium">
          Theme
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {THEMES.map((t) => (
            <ThemeCard
              key={t.id}
              id={t.id}
              label={t.label}
              active={theme === t.id}
              onSelect={setTheme}
            />
          ))}
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

      <section aria-labelledby="appearance-density-heading" className="space-y-3">
        <h2 id="appearance-density-heading" className="text-sm font-medium">
          Density
        </h2>
        <p className="text-sm text-fg-muted">
          Compact and comfortable density options arrive with the engine-backed settings store.
        </p>
      </section>
    </SettingsPage>
  )
}

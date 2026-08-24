import { Check, Monitor } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { Switch } from '@ari/ui/switch'
import { useTheme } from '@ari/ui/theme-provider'
import { themeChipRoles, themeList } from '@ari/ui/themes'
import type { Theme, ThemeId } from '@ari/ui/themes'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:appearance')

function ThemeChips({ theme }: { theme: Theme }) {
  return (
    <span className="flex shrink-0 gap-1" aria-hidden="true">
      {themeChipRoles.map((role) => (
        <span
          key={role}
          className="size-3.5 rounded-full border border-border"
          style={{ background: theme.colors[role] }}
        />
      ))}
    </span>
  )
}

function ThemeCard({
  label,
  description,
  selected,
  chips,
  onSelect,
}: {
  label: string
  description: string
  selected: boolean
  chips: React.ReactNode
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent-subtle'
          : 'border-border bg-surface-1 hover:border-border-strong'
      }`}
    >
      {chips}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{label}</span>
        <span className="block text-xs leading-relaxed text-fg-muted">{description}</span>
      </span>
      {selected ? <Check size={14} className="shrink-0 text-accent" aria-hidden="true" /> : null}
    </button>
  )
}

function ThemeGroup({
  title,
  themes,
  selectedMode,
  onSelect,
}: {
  title: string
  themes: readonly Theme[]
  selectedMode: string
  onSelect: (id: ThemeId) => void
}) {
  return (
    <section className="mt-4" aria-label={title}>
      <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-fg-subtle">{title}</h3>
      <div role="radiogroup" aria-label={title} className="grid gap-2">
        {themes.map((theme) => (
          <ThemeCard
            key={theme.id}
            label={theme.label}
            description={theme.description}
            selected={selectedMode === theme.id}
            chips={<ThemeChips theme={theme} />}
            onSelect={() => onSelect(theme.id)}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Appearance settings: theme picker (Light/Dark groups plus "Follow system"),
 * the glass opt-in for glass-capable themes, and reduced motion. Theme state
 * lives in the ThemeProvider, which persists through the engine settings store;
 * reduced motion is written here directly.
 */
export function AppearanceSettings() {
  const { settings, update } = useEngineSettings()
  const { mode, setMode, theme, glassPreference, glassEnabled, setGlass } = useTheme()
  const reducedMotion = settings?.appearance.reducedMotion ?? false

  const handleReducedMotionChange = (checked: boolean) => {
    void update({ appearance: { reducedMotion: checked } }).catch((error: unknown) => {
      log.warn('failed to persist reduced motion', { error })
    })
  }

  const dark = themeList.filter((t) => t.scheme === 'dark')
  const light = themeList.filter((t) => t.scheme === 'light')

  return (
    <SettingsPage title="Appearance">
      <SettingsRow
        label="Theme"
        hint="Pick a palette, or follow the system light/dark preference."
      >
        <span className="text-xs text-fg-muted">{theme.label}</span>
      </SettingsRow>

      <div role="radiogroup" aria-label="Follow system">
        <ThemeCard
          label="Follow system"
          description="Obsidian when the OS is dark, Porcelain when it is light."
          selected={mode === 'system'}
          chips={<Monitor size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />}
          onSelect={() => setMode('system')}
        />
      </div>

      <ThemeGroup title="Dark" themes={dark} selectedMode={mode} onSelect={setMode} />
      <ThemeGroup title="Light" themes={light} selectedMode={mode} onSelect={setMode} />

      <div className="mt-4">
        {theme.glass ? (
          <SettingsRow
            label="Glass chrome"
            hint={
              glassEnabled
                ? 'Translucent sidebar, titlebar, and overlays.'
                : 'Disabled by the system reduced-transparency setting.'
            }
          >
            <Switch
              checked={glassPreference}
              onCheckedChange={setGlass}
              aria-label="Glass chrome"
            />
          </SettingsRow>
        ) : null}
        <SettingsRow label="Reduce motion" hint="Minimize animations throughout the app.">
          <Switch
            checked={reducedMotion}
            onCheckedChange={handleReducedMotionChange}
            aria-label="Reduce motion"
          />
        </SettingsRow>
      </div>
    </SettingsPage>
  )
}

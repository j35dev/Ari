import { Check, Monitor } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { SegmentedControl } from '@ari/ui/segmented-control'
import { Switch } from '@ari/ui/switch'
import { useTheme } from '@ari/ui/theme-provider'
import { themeChipRoles, themeList } from '@ari/ui/themes'
import type { Theme, ThemeId } from '@ari/ui/themes'
import { wallpaperLooks, wallpapers } from '@ari/ui/wallpapers'
import type { Wallpaper, WallpaperLookId } from '@ari/ui/wallpapers'
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

/** 16:9 preview of a bundled scene; 'none' renders the plain theme backdrop. */
function WallpaperThumb({ wallpaper, theme }: { wallpaper: Wallpaper | null; theme: Theme }) {
  if (wallpaper) {
    return (
      <img
        src={wallpaper.src}
        alt=""
        aria-hidden="true"
        className="h-14 w-24 shrink-0 rounded border border-border object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="h-14 w-24 shrink-0 rounded border border-border"
      style={{ background: theme.colors.bg }}
    />
  )
}

function WallpaperGroup({
  theme,
  selected,
  onSelect,
}: {
  theme: Theme
  selected: string
  onSelect: (wallpaper: 'none' | Wallpaper['id']) => void
}) {
  return (
    <section className="mt-4" aria-label="Wallpaper">
      <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-fg-subtle">Wallpaper</h3>
      <div role="radiogroup" aria-label="Wallpaper" className="grid gap-2">
        <ThemeCard
          label="None"
          description="Solid theme background — the scene layers under every palette."
          selected={selected === 'none'}
          chips={<WallpaperThumb wallpaper={null} theme={theme} />}
          onSelect={() => onSelect('none')}
        />
        {wallpapers.map((wallpaper) => (
          <ThemeCard
            key={wallpaper.id}
            label={wallpaper.label}
            description={`${wallpaper.description} Softly scrimmed; text and theme stay in front.`}
            selected={selected === wallpaper.id}
            chips={<WallpaperThumb wallpaper={wallpaper} theme={theme} />}
            onSelect={() => onSelect(wallpaper.id)}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Appearance settings: theme picker (Light/Dark groups plus "Follow system"),
 * the wallpaper picker, the glass opt-in for glass-capable themes, and reduced
 * motion. Theme and wallpaper state live in the ThemeProvider, which persists
 * through the engine settings store; reduced motion is written here directly.
 */
export function AppearanceSettings() {
  const { settings, update } = useEngineSettings()
  const {
    mode,
    setMode,
    theme,
    glassPreference,
    glassEnabled,
    setGlass,
    wallpaper,
    setWallpaper,
    wallpaperLook,
    setWallpaperLook,
  } = useTheme()
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
          description="Matches your OS light and dark preference automatically."
          selected={mode === 'system'}
          chips={<Monitor size={14} className="shrink-0 text-fg-muted" aria-hidden="true" />}
          onSelect={() => setMode('system')}
        />
      </div>

      <ThemeGroup title="Dark" themes={dark} selectedMode={mode} onSelect={setMode} />
      <ThemeGroup title="Light" themes={light} selectedMode={mode} onSelect={setMode} />

      <WallpaperGroup theme={theme} selected={wallpaper} onSelect={setWallpaper} />

      {wallpaper !== 'none' ? (
        <SettingsRow
          label="Wallpaper visibility"
          hint={
            wallpaperLooks.find((look) => look.id === wallpaperLook)?.description ??
            wallpaperLooks[1].description
          }
        >
          <SegmentedControl
            size="sm"
            role="group"
            aria-label="Wallpaper visibility"
            options={wallpaperLooks.map((look) => ({ value: look.id, label: look.label }))}
            value={wallpaperLook}
            onChange={(value) => setWallpaperLook(value as WallpaperLookId)}
          />
        </SettingsRow>
      ) : null}

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

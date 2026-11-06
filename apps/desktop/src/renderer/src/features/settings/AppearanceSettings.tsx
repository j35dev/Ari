import { Check, Monitor } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { Switch } from '@ari/ui/switch'
import { useTheme } from '@ari/ui/theme-provider'
import { themeList } from '@ari/ui/themes'
import type { Theme, ThemeId } from '@ari/ui/themes'
import { wallpapers } from '@ari/ui/wallpapers'
import { defaultSettings, type Settings } from '@ari/contracts/settings'
import { codeFonts, interfaceFonts } from '../../lib/appearance'
import type { Wallpaper } from '@ari/ui/wallpapers'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:appearance')

/**
 * Miniature window painted from the registry palette: a sidebar with one
 * active row, a transcript with an accent reply. Shows how the theme actually
 * reads instead of four abstract dots.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const { colors } = theme
  const line = (width: string, color: string) => (
    <span className="block h-0.5 rounded-full" style={{ width, background: color }} />
  )
  return (
    <span
      aria-hidden="true"
      className="flex h-14 w-24 shrink-0 overflow-hidden rounded border border-border"
      style={{ background: colors.bg, color: colors.fg }}
    >
      <span
        className="flex w-8 shrink-0 flex-col gap-1 p-1.5"
        style={{ background: colors['surface-0'], borderRight: `1px solid ${colors.border}` }}
      >
        {line('60%', colors['fg-subtle'])}
        <span className="mt-0.5 h-1.5 rounded-sm" style={{ background: colors['surface-2'] }} />
        {line('80%', colors['surface-3'])}
        {line('65%', colors['surface-3'])}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
        {line('70%', colors['fg-muted'])}
        {line('45%', colors['fg-subtle'])}
        <span
          className="mt-auto h-2.5 w-4/5 self-end rounded-sm"
          style={{ background: colors['surface-1'], border: `1px solid ${colors.border}` }}
        />
        <span className="h-1 w-2/5 rounded-full" style={{ background: colors.accent }} />
      </span>
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
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        selected
          ? 'border-accent/60 bg-accent-subtle'
          : 'border-border bg-surface-1 hover:border-border-strong hover:bg-surface-2'
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
      <div role="radiogroup" aria-label={title} className="ari-theme-grid grid gap-2">
        {themes.map((theme) => (
          <ThemeCard
            key={theme.id}
            label={theme.label}
            description={theme.description}
            selected={selectedMode === theme.id}
            chips={<ThemePreview theme={theme} />}
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
      <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-fg-subtle">
        Wallpaper
      </h3>
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
 * wallpaper picker, and reduced motion. Theme and wallpaper state live in the
 * ThemeProvider, which persists through the engine settings store; reduced
 * motion is written here directly.
 */
export function AppearanceSettings() {
  const { settings, update } = useEngineSettings()
  const { mode, setMode, theme, wallpaper, setWallpaper } = useTheme()
  const reducedMotion = settings?.appearance.reducedMotion ?? false
  const saveAppearance = (patch: Partial<Settings['appearance']>) => {
    void update({ appearance: patch }).catch((error: unknown) => {
      log.warn('failed to persist appearance', { error })
    })
  }
  const selectClass =
    'max-w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

  const handleReducedMotionChange = (checked: boolean) => {
    void update({ appearance: { reducedMotion: checked } }).catch((error: unknown) => {
      log.warn('failed to persist reduced motion', { error })
    })
  }

  const dark = themeList.filter((t) => t.scheme === 'dark')
  const light = themeList.filter((t) => t.scheme === 'light')

  return (
    <SettingsPage title="Appearance">
      <section aria-label="Typography and chat" className="mb-6">
        <SettingsRow
          label="Interface font"
          hint="Choose the typeface for the app and conversation. Bundled fonts also work offline."
        >
          <select
            aria-label="Interface font"
            value={settings?.appearance.fontFamily ?? 'theme'}
            className={selectClass}
            onChange={(event) =>
              saveAppearance({
                fontFamily: event.target.value as Settings['appearance']['fontFamily'],
              })
            }
          >
            {interfaceFonts.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          label="Code and terminal font"
          hint="Set the monospace face for code, diffs, terminal chat, and shell panes."
        >
          <select
            aria-label="Code and terminal font"
            value={settings?.appearance.codeFont ?? 'geist-mono'}
            className={selectClass}
            onChange={(event) =>
              saveAppearance({ codeFont: event.target.value as Settings['appearance']['codeFont'] })
            }
          >
            {codeFonts.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label="Text size" hint="Scale text and controls together throughout the app.">
          <select
            aria-label="Text size"
            value={settings?.appearance.fontSize ?? defaultSettings.appearance.fontSize}
            className={selectClass}
            onChange={(event) =>
              saveAppearance({
                fontSize: Number(event.target.value) as Settings['appearance']['fontSize'],
              })
            }
          >
            <option value={14}>14 · Small</option>
            <option value={15}>15</option>
            <option value={16}>16 · Default</option>
            <option value={17}>17</option>
            <option value={18}>18 · Medium</option>
            <option value={19}>19</option>
            <option value={20}>20 · Large</option>
            <option value={22}>22 · Extra large</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Chat width"
          hint="Comfortable keeps Ari's original centered width. Choose a wider layout to use more of your workspace."
        >
          <select
            aria-label="Chat width"
            value={settings?.appearance.chatWidth ?? 'comfortable'}
            className={selectClass}
            onChange={(event) =>
              saveAppearance({
                chatWidth: event.target.value as Settings['appearance']['chatWidth'],
              })
            }
          >
            <option value="focused">Focused · 640 px</option>
            <option value="comfortable">Comfortable · 768 px (default)</option>
            <option value="balanced">Balanced · 960 px</option>
            <option value="wide">Wide · 1200 px</option>
            <option value="full">Full width</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Chat style"
          hint="Conversation formats replies. Terminal shows plain streamed text and keeps commands, edits, and results expanded."
        >
          <select
            aria-label="Chat style"
            value={settings?.appearance.chatStyle ?? 'conversation'}
            className={selectClass}
            onChange={(event) =>
              saveAppearance({
                chatStyle: event.target.value as Settings['appearance']['chatStyle'],
              })
            }
          >
            <option value="conversation">Conversation</option>
            <option value="terminal">Terminal</option>
          </select>
        </SettingsRow>
        <div
          className="ari-appearance-preview mt-4 rounded-xl bg-surface-1 px-5 py-4"
          aria-label="Typography preview"
        >
          <p className="mb-2 text-xs text-fg-muted">Preview</p>
          <p className="ari-chat-copy text-fg">A little more room to think.</p>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            Explore your project, follow the work, and shape what comes next.
          </p>
          <code className="mt-3 block font-mono text-xs text-accent">{'> ari / workspace'}</code>
        </div>
      </section>
      <SettingsRow label="Theme" hint="Pick a palette, or follow the system light/dark preference.">
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

      <div className="mt-4">
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

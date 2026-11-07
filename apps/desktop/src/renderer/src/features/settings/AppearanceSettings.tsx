import type { ReactNode } from 'react'
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
import { SettingsCard, SettingsSection } from './SettingsSection'
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
    <span className="block h-1 rounded-full" style={{ width, background: color }} />
  )
  return (
    <span
      aria-hidden="true"
      className="flex h-[76px] w-full overflow-hidden rounded-md"
      style={{ background: colors.bg, color: colors.fg }}
    >
      <span
        className="flex w-[30%] shrink-0 flex-col gap-1.5 p-2"
        style={{ background: colors['surface-0'], borderRight: `1px solid ${colors.border}` }}
      >
        {line('55%', colors['fg-subtle'])}
        <span className="mt-0.5 h-2.5 rounded-sm" style={{ background: colors['surface-2'] }} />
        {line('80%', colors['surface-3'])}
        {line('65%', colors['surface-3'])}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        {line('70%', colors['fg-muted'])}
        {line('45%', colors['fg-subtle'])}
        <span
          className="mt-auto h-4 w-4/5 self-end rounded"
          style={{ background: colors['surface-1'], border: `1px solid ${colors.border}` }}
        />
        <span className="h-1 w-2/5 rounded-full" style={{ background: colors.accent }} />
      </span>
    </span>
  )
}

/** Selectable tile: visual preview on top, name and one line of copy below. */
function PreviewTile({
  label,
  description,
  selected,
  preview,
  onSelect,
}: {
  label: string
  description: string
  selected: boolean
  preview: ReactNode
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`group flex w-full flex-col gap-2.5 rounded-xl border bg-surface-1/70 p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        selected
          ? 'border-accent/70 ring-1 ring-accent/40'
          : 'border-border hover:border-border-strong hover:bg-surface-2/60'
      }`}
    >
      <span className="relative block">
        {preview}
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-fg-on-accent shadow-sm"
          >
            <Check size={12} strokeWidth={2.5} />
          </span>
        ) : null}
      </span>
      <span className="block px-1 pb-1">
        <span className="block text-sm font-medium text-fg">{label}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-muted">
          {description}
        </span>
      </span>
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
    <section aria-label={title}>
      <h3 className="mb-2.5 px-1 text-xs font-medium text-fg-muted">{title}</h3>
      <div role="radiogroup" aria-label={title} className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {themes.map((theme) => (
          <PreviewTile
            key={theme.id}
            label={theme.label}
            description={theme.description}
            selected={selectedMode === theme.id}
            preview={<ThemePreview theme={theme} />}
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
        className="block aspect-video w-full rounded-md object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="block aspect-video w-full rounded-md"
      style={{
        background: theme.colors.bg,
        boxShadow: `inset 0 0 0 1px ${theme.colors.border}`,
      }}
    />
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
  const followingSystem = mode === 'system'

  return (
    <SettingsPage title="Appearance" description="Palette, wallpaper, type, and motion.">
      <SettingsSection
        title="Typography"
        description="Fonts, size, width, and how the conversation reads."
      >
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
        <SettingsRow
          label="Text size"
          hint="Adjust chat messages and the composer. Sidebar and app controls keep their original size."
        >
          <select
            aria-label="Text size"
            value={Math.min(
              18,
              settings?.appearance.fontSize ?? defaultSettings.appearance.fontSize,
            )}
            className={selectClass}
            onChange={(event) =>
              saveAppearance({
                fontSize: Number(event.target.value) as Settings['appearance']['fontSize'],
              })
            }
          >
            <option value={14}>Small</option>
            <option value={15}>Compact</option>
            <option value={16}>Default</option>
            <option value={17}>Comfortable</option>
            <option value={18}>Larger</option>
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
          hint="Conversation formats replies. Terminal is a command log: edits and notes stay open, and shell output stays one line until you open it."
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
      </SettingsSection>
      <SettingsSection
        title="Theme"
        description="Pick a palette, or follow the system light/dark preference."
        action={<span className="text-xs text-fg-muted">{theme.label}</span>}
        bare
      >
        <div className="space-y-6">
          <SettingsCard>
            <div role="radiogroup" aria-label="Follow system">
              <button
                type="button"
                role="radio"
                aria-checked={followingSystem}
                onClick={() => setMode('system')}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <Monitor size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">Follow system</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
                    Matches your OS light and dark preference automatically.
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    followingSystem ? 'border-accent bg-accent' : 'border-border-strong'
                  }`}
                >
                  {followingSystem ? (
                    <span className="size-1.5 rounded-full bg-fg-on-accent" />
                  ) : null}
                </span>
              </button>
            </div>
          </SettingsCard>
          <ThemeGroup title="Dark" themes={dark} selectedMode={mode} onSelect={setMode} />
          <ThemeGroup title="Light" themes={light} selectedMode={mode} onSelect={setMode} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Wallpaper"
        description="A scene behind every palette, softly scrimmed so text stays readable."
        bare
      >
        <div
          role="radiogroup"
          aria-label="Wallpaper"
          className="grid grid-cols-2 gap-3 lg:grid-cols-3"
        >
          <PreviewTile
            label="None"
            description="Solid theme background."
            selected={wallpaper === 'none'}
            preview={<WallpaperThumb wallpaper={null} theme={theme} />}
            onSelect={() => setWallpaper('none')}
          />
          {wallpapers.map((entry) => (
            <PreviewTile
              key={entry.id}
              label={entry.label}
              description={entry.description}
              selected={wallpaper === entry.id}
              preview={<WallpaperThumb wallpaper={entry} theme={theme} />}
              onSelect={() => setWallpaper(entry.id)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Motion">
        <SettingsRow label="Reduce motion" hint="Minimize animations throughout the app.">
          <Switch
            checked={reducedMotion}
            onCheckedChange={handleReducedMotionChange}
            aria-label="Reduce motion"
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}

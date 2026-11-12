import type { ReactNode } from 'react'
import { Monitor } from 'lucide-react'
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
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
  SettingsSection,
} from './SettingsSection'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:appearance')

/**
 * A theme in three chips from the registry palette: the page, a raised
 * surface, and the accent. Enough to tell the palettes apart at a glance.
 */
function ThemeChips({ theme }: { theme: Theme }) {
  const { colors } = theme
  const chip = (color: string) => (
    <span
      className="size-[18px] rounded-sm"
      style={{ background: color, boxShadow: `inset 0 0 0 1px ${colors.border}` }}
    />
  )
  return (
    <span aria-hidden="true" className="flex gap-1">
      {chip(colors.bg)}
      {chip(colors['surface-2'])}
      {chip(colors.accent)}
    </span>
  )
}

/** Grids of swatches: as many 140px columns as the card has room for. */
const SWATCH_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5'

/**
 * Selectable swatch: a preview above its name. Selection is an ink border and
 * ink text, never an accent fill.
 */
function SwatchTile({
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
      title={description}
      onClick={onSelect}
      className={`flex w-full min-w-0 flex-col gap-2 rounded-lg border p-2.5 text-left text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        selected
          ? 'border-fg text-fg'
          : 'border-border text-fg-muted hover:border-border-strong hover:text-fg'
      }`}
    >
      {preview}
      <span className="block truncate">{label}</span>
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
    <section aria-label={title} className="p-3.5">
      <h3 className="mb-2.5 px-0.5 text-[13px] text-fg-subtle">{title}</h3>
      <div role="radiogroup" aria-label={title} className={SWATCH_GRID_CLASS}>
        {themes.map((theme) => (
          <SwatchTile
            key={theme.id}
            label={theme.label}
            description={theme.description}
            selected={selectedMode === theme.id}
            preview={<ThemeChips theme={theme} />}
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
        className="block aspect-video w-full rounded-sm object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="block aspect-video w-full rounded-sm"
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
  const selectClass = SETTINGS_FIELD_CLASS

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
        <div className="ari-appearance-preview px-4 py-3.5" aria-label="Typography preview">
          <p className="mb-2 text-[13px] text-fg-subtle">Preview</p>
          <p className="ari-chat-copy text-fg">A little more room to think.</p>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            Explore your project, follow the work, and shape what comes next.
          </p>
          <code className="mt-3 block font-mono text-[12.5px] text-fg-muted">
            {'> ari / workspace'}
          </code>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Theme"
        description="Pick a palette, or follow the system light/dark preference."
        action={<span className="text-[13px] text-fg-subtle">{theme.label}</span>}
      >
        <div role="radiogroup" aria-label="Follow system">
          <button
            type="button"
            role="radio"
            aria-checked={followingSystem}
            onClick={() => setMode('system')}
            className="flex w-full items-center gap-3 rounded-t-xl px-4 py-3.5 text-left transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <Monitor
              size={16}
              strokeWidth={1.7}
              className="shrink-0 text-fg-subtle"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className={`block ${SETTINGS_LABEL_CLASS}`}>Follow system</span>
              <span className={`mt-0.5 block ${SETTINGS_HINT_CLASS}`}>
                Matches your OS light and dark preference automatically.
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                followingSystem ? 'border-fg bg-fg' : 'border-border-strong'
              }`}
            >
              {followingSystem ? <span className="size-1.5 rounded-full bg-bg" /> : null}
            </span>
          </button>
        </div>
        <ThemeGroup title="Dark" themes={dark} selectedMode={mode} onSelect={setMode} />
        <ThemeGroup title="Light" themes={light} selectedMode={mode} onSelect={setMode} />
      </SettingsSection>

      <SettingsSection
        title="Wallpaper"
        description="A scene behind every palette, softly scrimmed so text stays readable."
      >
        <div role="radiogroup" aria-label="Wallpaper" className={`${SWATCH_GRID_CLASS} p-3.5`}>
          <SwatchTile
            label="None"
            description="Solid theme background."
            selected={wallpaper === 'none'}
            preview={<WallpaperThumb wallpaper={null} theme={theme} />}
            onSelect={() => setWallpaper('none')}
          />
          {wallpapers.map((entry) => (
            <SwatchTile
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

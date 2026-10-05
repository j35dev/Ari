import type { ReactNode } from 'react'
import { Check, SunMoon } from 'lucide-react'
import { useTheme } from '@ari/ui/theme-provider'
import { themeList, type Theme } from '@ari/ui/themes'

/** Every Ari theme as a miniature of itself, plus following the phone's own setting. */
export function ThemePicker(): ReactNode {
  const { mode, setMode } = useTheme()
  return (
    <div role="radiogroup" aria-label="Theme" className="space-y-4">
      <button
        type="button"
        role="radio"
        aria-label="System"
        aria-checked={mode === 'system'}
        onClick={() => setMode('system')}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-border bg-surface-1 px-4 text-left aria-checked:border-accent"
      >
        <SunMoon size={19} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">System</span>
          <span className="block text-xs text-fg-muted">Light or dark, following this phone</span>
        </span>
        {mode === 'system' && <Check size={17} className="shrink-0 text-accent" />}
      </button>
      {(['dark', 'light'] as const).map((scheme) => (
        <div key={scheme}>
          <p className="mb-2 text-xs text-fg-subtle">{scheme === 'dark' ? 'Dark' : 'Light'}</p>
          <div className="grid grid-cols-2 gap-3">
            {themeList
              .filter((theme) => theme.scheme === scheme)
              .map((theme) => (
                <Swatch
                  key={theme.id}
                  theme={theme}
                  selected={mode === theme.id}
                  onSelect={() => setMode(theme.id)}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Swatch({
  theme,
  selected,
  onSelect,
}: {
  theme: Theme
  selected: boolean
  onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-label={theme.label}
      aria-checked={selected}
      onClick={onSelect}
      className="overflow-hidden rounded-2xl border border-border text-left aria-checked:border-accent"
    >
      {/* The attribute re-scopes every token, so the miniature is drawn in the theme's own colours. */}
      <span data-ari-theme={theme.id} aria-hidden className="block bg-bg p-3">
        <span className="ml-auto block h-4 w-3/5 rounded-full bg-surface-2" />
        <span className="mt-2.5 block h-1.5 w-4/5 rounded-full bg-fg-muted" />
        <span className="mt-1.5 block h-1.5 w-1/2 rounded-full bg-fg-subtle" />
        <span className="mt-2.5 flex items-center gap-2 rounded-full bg-surface-1 p-1">
          <span className="h-1.5 flex-1 rounded-full bg-surface-3" />
          <span className="size-4 rounded-full bg-accent" />
        </span>
      </span>
      <span className="flex min-h-11 items-center justify-between gap-2 bg-surface-1 px-3 text-sm">
        <span className={selected ? 'font-medium' : ''}>{theme.label}</span>
        {selected && <Check size={15} className="shrink-0 text-accent" />}
      </span>
    </button>
  )
}

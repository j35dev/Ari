import { Kbd } from '@ari/ui/kbd'
import { SettingsPage } from './SettingsPage'
import { APP_SHORTCUTS } from './shortcuts'

function isApplePlatform(): boolean {
  return /mac|iphone|ipad|ipod/i.test(navigator.platform)
}

/** Splits a logical chord into display keys, resolving `Mod` for the current platform. */
export function resolveChord(chord: string): string[] {
  const modLabel = isApplePlatform() ? 'Cmd' : 'Ctrl'
  return chord.split('+').map((key) => (key === 'Mod' ? modLabel : key))
}

/** Keybindings settings page: read-only table of the app's logical shortcuts. */
export function KeybindingsSettings() {
  return (
    <SettingsPage
      title="Keybindings"
      description="Every shortcut the workspace responds to."
    >
      <section aria-labelledby="keybindings-map-heading" className="space-y-3">
        <h2 id="keybindings-map-heading" className="text-sm font-medium">
          Shortcuts
        </h2>
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
          {APP_SHORTCUTS.map((shortcut) => {
            const keys = resolveChord(shortcut.chord)
            return (
              <li
                key={shortcut.id}
                className="flex items-center justify-between gap-4 px-3 py-2"
              >
                <span className="text-sm text-fg">{shortcut.label}</span>
                <span
                  className="flex shrink-0 items-center gap-1"
                  aria-label={`${shortcut.label}: ${keys.join(' plus ')}`}
                >
                  {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="text-sm text-fg-muted">
          Read-only in v1 — remapping lands with the keybindings layer.
        </p>
      </section>
    </SettingsPage>
  )
}

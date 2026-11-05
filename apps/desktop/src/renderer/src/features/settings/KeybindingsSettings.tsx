import { Kbd } from '@ari/ui/kbd'
import { SettingsPage } from './SettingsPage'
import { SETTINGS_CARD_CLASS, SettingsSection } from './SettingsSection'
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
    <SettingsPage title="Keybindings" description="Every shortcut the workspace responds to.">
      <SettingsSection
        title="Shortcuts"
        headingId="keybindings-map-heading"
        description="Read-only for now; remapping lands with the keybindings layer."
        bare
      >
        <ul className={SETTINGS_CARD_CLASS}>
          {APP_SHORTCUTS.map((shortcut) => {
            const keys = resolveChord(shortcut.chord)
            return (
              <li
                key={shortcut.id}
                className="flex min-h-11 items-center justify-between gap-4 px-4 py-2"
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
      </SettingsSection>
    </SettingsPage>
  )
}

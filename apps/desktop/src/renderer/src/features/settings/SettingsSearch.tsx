import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Input } from '@ari/ui/input'

export interface SettingsIndexEntry {
  /** Element id of the wrapping section this entry scrolls to. */
  section: string
  /** Human-readable setting label shown as the result row. */
  label: string
  /** Extra match terms beyond the label and section name. */
  keywords: string
}

/**
 * Static search index over every settings surface (M12.9). Section ids are
 * emitted by each page's `SettingsPage` wrapper (`settings-appearance`, …).
 * Shell-owned sections (Providers, Endpoints) resolve once their wrappers
 * carry matching ids; until then clicks fall through harmlessly.
 */
export const SETTINGS_SEARCH_INDEX = [
  {
    section: 'settings-appearance',
    label: 'Theme',
    keywords: 'comet glass accent light dark preview appearance',
  },
  {
    section: 'settings-appearance',
    label: 'Reduce motion',
    keywords: 'animation accessibility movement transitions',
  },
  {
    section: 'settings-appearance',
    label: 'Density',
    keywords: 'compact comfortable spacing layout',
  },
  {
    section: 'settings-providers',
    label: 'Detected providers',
    keywords: 'claude codex opencode grok pi hermes detect rescan health install auth badge',
  },
  {
    section: 'settings-permissions',
    label: 'Default permission mode',
    keywords: 'ask allow edits full access approve confirm agent tools',
  },
  {
    section: 'settings-permissions',
    label: 'Always-allow commands',
    keywords: 'allowlist run without confirmation exact command',
  },
  {
    section: 'settings-endpoints',
    label: 'Model endpoints',
    keywords: 'openai anthropic ollama api key base url custom connection test chat completions',
  },
  {
    section: 'settings-keybindings',
    label: 'Keyboard shortcuts',
    keywords: 'keybindings keys chords remap mod ctrl cmd cheat sheet map',
  },
  {
    section: 'settings-advanced',
    label: 'Export diagnostics',
    keywords: 'bug report debug json version user agent',
  },
  {
    section: 'settings-advanced',
    label: 'Settings bundle',
    keywords: 'import export backup migrate json device transfer',
  },
  {
    section: 'settings-advanced',
    label: 'Journal location',
    keywords: 'journal storage sessions folder backup data directory jsonl history',
  },
  {
    section: 'settings-advanced',
    label: 'Clear cached drafts',
    keywords: 'drafts cache delete danger zone reset composer unsent',
  },
] as const satisfies readonly SettingsIndexEntry[]

/** Case-insensitive substring match across label, section name, and keywords. */
export function filterSettingsIndex(query: string): readonly SettingsIndexEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return SETTINGS_SEARCH_INDEX
  return SETTINGS_SEARCH_INDEX.filter((entry) =>
    `${entry.label} ${entry.section} ${entry.keywords}`.toLowerCase().includes(needle),
  )
}

function groupLabel(section: string): string {
  const name = section.replace(/^settings-/, '')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Settings search (M12.9): filters the static index and jumps to the matching
 * section on click via smooth `scrollIntoView`. A polite live region reports
 * the result count so keyboard and screen-reader users get filter feedback.
 */
export function SettingsSearch({
  onJump,
}: {
  /** Optional: switch the settings overlay to the matching section before scrolling. */
  onJump?: (section: string) => void
} = {}) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => filterSettingsIndex(query), [query])

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value)
  }

  const jumpToSection = (section: string): void => {
    onJump?.(section)
    const target = document.getElementById(section)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' })
      return
    }
    requestAnimationFrame(() => {
      document.getElementById(section)?.scrollIntoView({ behavior: 'smooth' })
    })
  }

  return (
    <div className="space-y-3">
      <Input
        type="search"
        aria-label="Search settings"
        placeholder="Search settings…"
        value={query}
        onChange={handleQueryChange}
      />
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
        {results.map((entry) => (
          <li key={`${entry.section}:${entry.label}`}>
            <button
              type="button"
              onClick={() => jumpToSection(entry.section)}
              className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
            >
              <span className="text-sm text-fg">{entry.label}</span>
              <span className="shrink-0 text-xs text-fg-subtle">{groupLabel(entry.section)}</span>
            </button>
          </li>
        ))}
        {results.length === 0 && (
          <li className="px-3 py-2 text-sm text-fg-subtle">No matching settings</li>
        )}
      </ul>
      <p role="status" className="sr-only">
        {results.length} {results.length === 1 ? 'result' : 'results'}
      </p>
    </div>
  )
}

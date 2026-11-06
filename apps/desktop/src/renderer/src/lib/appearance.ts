import { defaultSettings, settingsUpdateSchema, type Settings } from '@ari/contracts/settings'

const CACHE_KEY = 'ari.appearance'
type Appearance = Settings['appearance']

export const interfaceFonts = [
  { id: 'theme', label: 'Theme default', family: null },
  { id: 'geist', label: 'Geist', family: "'Geist Variable', 'Segoe UI', system-ui, sans-serif" },
  {
    id: 'system',
    label: 'System sans',
    family: "'Segoe UI', system-ui, -apple-system, sans-serif",
  },
  { id: 'mono', label: 'Geist Mono', family: 'var(--ari-font-mono)' },
  { id: 'serif', label: 'Book serif', family: "'Charter', 'Georgia', serif" },
] as const

/** Apply before mount and after engine saves so every pane uses the same scale. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement
  root.style.fontSize = `${appearance.fontSize}px`
  const family = interfaceFonts.find((font) => font.id === appearance.fontFamily)?.family
  if (family) root.style.setProperty('--ari-font-ui', family)
  else root.style.removeProperty('--ari-font-ui')
  root.dataset['ariChatWidth'] = appearance.chatWidth
  root.dataset['ariChatStyle'] = appearance.chatStyle
}

export function cacheAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(appearance))
  } catch {
    // Engine storage remains authoritative when the first-paint cache is unavailable.
  }
}

export function applyCachedAppearance(): void {
  let appearance = defaultSettings.appearance
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const parsed = settingsUpdateSchema.safeParse({ appearance: JSON.parse(raw) as unknown })
      if (parsed.success) appearance = { ...appearance, ...parsed.data.appearance }
    }
  } catch {
    // Invalid or unavailable cache: paint the defaults until the engine loads.
  }
  applyAppearance(appearance)
}

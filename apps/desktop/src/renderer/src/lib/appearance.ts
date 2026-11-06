import { defaultSettings, settingsUpdateSchema, type Settings } from '@ari/contracts/settings'

const CACHE_KEY = 'ari.appearance'
type Appearance = Settings['appearance']

const geistMono = "'Geist Mono Variable', 'Cascadia Code', ui-monospace, monospace"
const jetbrainsMono = "'JetBrains Mono Variable', 'Cascadia Code', ui-monospace, monospace"
const firaCode = "'Fira Code Variable', 'Cascadia Code', ui-monospace, monospace"

export const codeFonts = [
  { id: 'geist-mono', label: 'Geist Mono', family: geistMono },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: jetbrainsMono },
  { id: 'fira-code', label: 'Fira Code', family: firaCode },
  {
    id: 'cascadia',
    label: 'Cascadia Code (system)',
    family: "'Cascadia Code', 'Cascadia Mono', ui-monospace, monospace",
  },
  { id: 'system-mono', label: 'System monospace', family: 'ui-monospace, monospace' },
] as const

export const interfaceFonts = [
  { id: 'theme', label: 'Theme default', family: null },
  { id: 'geist', label: 'Geist', family: "'Geist Variable', 'Segoe UI', system-ui, sans-serif" },
  {
    id: 'system',
    label: 'System sans',
    family: "'Segoe UI', system-ui, -apple-system, sans-serif",
  },
  {
    id: 'manrope',
    label: 'Manrope',
    family: "'Manrope Variable', 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'source-sans',
    label: 'Source Sans 3',
    family: "'Source Sans 3 Variable', 'Segoe UI', system-ui, sans-serif",
  },
  { id: 'mono', label: 'Geist Mono', family: geistMono },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: jetbrainsMono },
  { id: 'fira-code', label: 'Fira Code', family: firaCode },
  {
    id: 'source-serif',
    label: 'Source Serif 4',
    family: "'Source Serif 4 Variable', 'Georgia', serif",
  },
  { id: 'serif', label: 'Book serif', family: "'Charter', 'Georgia', serif" },
] as const

/** Apply before mount and after engine saves so every pane uses the same scale. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement
  root.style.fontSize = `${appearance.fontSize}px`
  const codeFamily = codeFonts.find((font) => font.id === appearance.codeFont)?.family ?? geistMono
  root.style.setProperty('--ari-font-mono', codeFamily)
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

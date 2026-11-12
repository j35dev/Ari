/** Kokoro 2.x has dictionary-only English G2P. Every emitted word must be covered. */
export const ARIA_LEXICON = {
  ari: 'ˈ ɑ ɹ i', aria: 'ˈ ɑ ɹ i ə',
  codex: 'k ˈ O d ɛ k s', grok: 'ɡ ɹ ˈ ɑ k',
  opencode: 'ˈ O p ə n k ˌ O d', pi: 'p ˈ I',
  kokoro: 'k O k ˈ O ɹ O', groq: 'ɡ ɹ ˈ ɑ k',
  acp: 'ˌ A s ˌ i p ˈ i', cli: 's ˌ i ɛ l ˌ I', pr: 'p ˌ i ˈ ɑ ɹ',
} as const
const ones = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const tens = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid spoken number.')
  n = Math.round(n)
  if (n < 0) return `minus ${numberWords(-n)}`
  if (n < 20) return ones[n]!
  if (n < 100) return tens[Math.floor(n / 10)]! + (n % 10 ? ` ${numberWords(n % 10)}` : '')
  if (n < 1000) return `${numberWords(Math.floor(n / 100))} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size && n < 1e12) return `${numberWords(Math.floor(n / size))} ${name}${n % size ? ` ${numberWords(n % size)}` : ''}`
  }
  return String(n).split('').map(d => ones[Number(d)]!).join(' ')
}

export function normalizeSpeech(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/https?:\/\/([^/\s?#]+)[^\s]*/g, '$1')
    .replace(/\b([A-Z]{2,5})\b/g, value => ['PR', 'ACP', 'CLI'].includes(value) ? value.toLowerCase() : value.split('').join(' '))
    .replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)/g, (_, value: string) => `${numberWords(Number(value.replace(/,/g, '')))} dollars`)
    .replace(/-?\d+(?:,\d{3})*(?:\.\d+)?/g, value => numberWords(Number(value.replace(/,/g, ''))))
    .replace(/%/g, ' percent').replace(/&/g, ' and ').replace(/@/g, ' at ')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[’]/g, "'")
    .replace(/\s+/g, ' ').trim()
}

export function lexiconWords(lexicon: string): Set<string> {
  return new Set(lexicon.split(/\r?\n/).map(line => line.split(/\s+/)[0]!).filter(Boolean))
}

export function prepareKokoro(text: string, words: ReadonlySet<string>): { text: string; spelled: string[]; words: number } {
  const normalized = normalizeSpeech(text)
  // Refuse unsupported scripts rather than allowing the native engine to omit them.
  if (/[^\x00-\x7f]/.test(normalized)) throw new Error('Kokoro’s English voice cannot pronounce this text. Try Groq or edit the spoken line.')
  const spelled: string[] = []; let count = 0
  const covered = normalized.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, word => {
    count++
    const lower = word.toLowerCase()
    if (words.has(lower)) return lower
    spelled.push(word)
    const letters = lower.replace(/'/g, '').split('')
    if (letters.some(letter => !words.has(letter))) throw new Error('Kokoro’s pronunciation dictionary is incomplete. Download the model again.')
    return letters.join(' ')
  })
  return { text: covered, spelled, words: count }
}

/** Kokoro 2.x has dictionary-only English G2P. Every emitted word must be covered. */
export const ARIA_LEXICON = {
  ari: 'ˈ ɑ ɹ i',
  aria: 'ˈ ɑ ɹ i ə',
  codex: 'k ˈ O d ɛ k s',
  grok: 'ɡ ɹ ˈ ɑ k',
  opencode: 'ˈ O p ə n k ˌ O d',
  pi: 'p ˈ I',
  kokoro: 'k O k ˈ O ɹ O',
  groq: 'ɡ ɹ ˈ ɑ k',
  acp: 'ˌ A s ˌ i p ˈ i',
  cli: 's ˌ i ɛ l ˌ I',
  pr: 'p ˌ i ˈ ɑ ɹ',
  // The stock dictionary omits this everyday plural used by the fallback condenser.
  details: 'd ə t ˈ A l z',
} as const
const ones =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' ',
  )
const tens = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid spoken number.')
  n = Math.round(n)
  if (n < 0) return `minus ${numberWords(-n)}`
  if (n < 20) return ones[n]!
  if (n < 100) return tens[Math.floor(n / 10)]! + (n % 10 ? ` ${numberWords(n % 10)}` : '')
  if (n < 1000)
    return `${numberWords(Math.floor(n / 100))} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`
  for (const [size, name] of [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ] as const) {
    if (n >= size && n < 1e12)
      return `${numberWords(Math.floor(n / size))} ${name}${n % size ? ` ${numberWords(n % size)}` : ''}`
  }
  return String(n)
    .split('')
    .map((d) => ones[Number(d)]!)
    .join(' ')
}

export function normalizeSpeech(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Typography is not another language. Keep English words while translating
    // the punctuation commonly emitted by assistants into native-safe pauses.
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/(?<=\d)[–−](?=\d)/g, ' to ')
    .replace(/[—―]/g, ', ')
    .replace(/[‐‑‒–−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[→⇒]/g, ' to ')
    .replace(/https?:\/\/([^/\s?#]+)[^\s]*/g, (_, domain: string) => domain.replace(/\./g, ' dot '))
    .replace(/\b([A-Z]{2,5})\b/g, (value) =>
      ['PR', 'ACP', 'CLI'].includes(value) ? value.toLowerCase() : value.split('').join(' '),
    )
    .replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)/g, (_, value: string) =>
      Number(value.replace(/,/g, '')) < 1
        ? `${numberWords(Number(value.replace(/,/g, '')) * 100)} cents`
        : `${numberWords(Number(value.replace(/,/g, '')))} dollars`,
    )
    .replace(/-?\d+(?:,\d{3})*(?:\.\d+)?/g, (value) => {
      const n = Number(value.replace(/,/g, ''))
      if (Number.isInteger(n)) return numberWords(n)
      const rounded = Math.abs(n)
        .toFixed(Math.abs(n) < 1 ? 2 : 1)
        .replace(/0+$/, '')
        .replace(/\.$/, '')
      const [whole, fraction] = rounded.split('.')
      return `${n < 0 ? 'minus ' : ''}${numberWords(Number(whole))}${
        fraction
          ? ` point ${fraction
              .split('')
              .map((d) => numberWords(Number(d)))
              .join(' ')}`
          : ''
      }`
    })
    .replace(/%/g, ' percent')
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Groq has no pronunciation dictionary API; use simple spoken respellings. */
export function normalizeCloudSpeech(text: string): string {
  return normalizeSpeech(text)
    .replace(/\bAria\b/gi, 'Ah ree uh')
    .replace(/\bAri\b/gi, 'Ah ree')
    .replace(/\bpr\b/gi, 'P R')
    .replace(/\bacp\b/gi, 'A C P')
    .replace(/\bcli\b/gi, 'C L I')
}

export function lexiconWords(lexicon: string): Set<string> {
  return new Set(
    lexicon
      .split(/\r?\n/)
      .map((line) => line.split(/\s+/)[0]!)
      .filter(Boolean),
  )
}

export function prepareKokoro(
  text: string,
  words: ReadonlySet<string>,
): { text: string; spelled: string[]; words: number } {
  const normalized = normalizeSpeech(text)
  // Refuse unsupported scripts rather than allowing the native engine to omit them.
  if ([...normalized].some((character) => character.charCodeAt(0) > 127))
    throw new Error(
      'Kokoro’s English voice cannot read this language. Choose Groq in speech output settings.',
    )
  const spelled: string[] = []
  let count = 0
  const covered = normalized.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
    count++
    const lower = word.toLowerCase()
    if (words.has(lower)) return lower
    spelled.push(word)
    const letters = lower.replace(/'/g, '').split('')
    if (letters.some((letter) => !words.has(letter)))
      throw new Error('Kokoro’s pronunciation dictionary is incomplete. Download the model again.')
    return letters.join(' ')
  })
  return { text: covered, spelled, words: count }
}

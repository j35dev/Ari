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
  // Common status forms omitted by the pinned dictionary must remain spoken words.
  completed: 'k ə m p l ˈ i t ᵻ d',
  reviewed: 'ɹ ə v j ˈ u d',
  verified: 'v ˈ ɛ ɹ ə f ˌ I d',
  unloaded: 'ə n l ˈ O d ᵻ d',
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
  // Translate assistant typography into native-safe pauses without losing English words.
  return (
    text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/(?<=\d)[–−](?=\d)/g, ' to ')
      .replace(/[—―]/g, ', ')
      .replace(/[‐‑‒–−]/g, '-')
      .replace(/…/g, '...')
      .replace(/[→⇒]/g, ' to ')
      .replace(/https?:\/\/([^/\s?#]+)[^\s]*/g, (_, domain: string) =>
        domain.replace(/\./g, ' dot '),
      )
      .replace(/\b(?:PR|ACP|CLI)\b/g, (value) => value.toLowerCase())
      // Capitalization is often emphasis (READY, DONE), rather than an initialism.
      .replace(
        /\b(?:AI|API|CPU|GPU|UI|RPC|SDK|URL|USB|HTML|CSS|HTTP|HTTPS|STT|TTS|LLM)\b/g,
        (value) => value.split('').join(' '),
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
  )
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

const VOICELESS = new Set(['p', 't', 'k', 'f', 'θ'])
const SIBILANT = new Set(['s', 'z', 'ʃ', 'ʒ', 'ʧ', 'ʤ'])
/** Sibilants that take a plain "t" in the past tense: kissed, pushed, watched. */
const VOICELESS_SIBILANT = new Set(['s', 'ʃ', 'ʧ'])
const STRESS = new Set(['ˈ', 'ˌ'])
const isVowel = (letter: string | undefined): boolean =>
  letter !== undefined && 'aeiou'.includes(letter)

/**
 * The regular inflections of one dictionary word, each with its phonemes.
 * Kokoro's own G2P derives these in code; the dictionary-only engine here
 * does not, so "agents", "deleted" or "details" were missing and came out
 * spelled a letter at a time.
 */
export function inflections(word: string, phonemes: string): [string, string][] {
  const sounds = phonemes.split(' ').filter((sound) => sound && !STRESS.has(sound))
  const last = sounds.at(-1)
  if (last === undefined) return []
  const end = word.at(-1) ?? ''
  const before = word.at(-2)
  const consonantY = end === 'y' && !isVowel(before)
  // "stop" doubles its consonant and "open" does not; both spellings are cheap to list.
  const doubles = !isVowel(end) && !'wxy'.includes(end) && isVowel(before) && !isVowel(word.at(-3))
  const plural = SIBILANT.has(last) ? 'ᵻ z' : VOICELESS.has(last) ? 's' : 'z'
  const past =
    last === 't' || last === 'd'
      ? 'ᵻ d'
      : VOICELESS.has(last) || VOICELESS_SIBILANT.has(last)
        ? 't'
        : 'd'
  const stem = word.slice(0, -1)
  const forms: [string, string][] = []
  const add = (spelling: string, suffix: string): void => {
    forms.push([spelling, `${phonemes} ${suffix}`])
  }
  add(consonantY ? `${stem}ies` : /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`, plural)
  if (end === 'e') {
    add(`${word}d`, past)
    add(before === 'e' ? `${word}ing` : `${stem}ing`, 'ɪ ŋ')
  } else {
    add(consonantY ? `${stem}ied` : `${word}ed`, past)
    add(`${word}ing`, 'ɪ ŋ')
    if (doubles) {
      add(`${word}${end}ed`, past)
      add(`${word}${end}ing`, 'ɪ ŋ')
    }
  }
  return forms
}

/** Lexicon lines for every regular inflection the dictionary does not already list. */
export function expandLexicon(lexicon: string): string {
  const known = new Map<string, string>()
  for (const line of lexicon.split(/\r?\n/)) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const word = line.slice(0, space)
    if (!known.has(word)) known.set(word, line.slice(space + 1).trim())
  }
  const derived = new Map<string, string>()
  for (const [word, phonemes] of known) {
    // Short function words, and anything with digits or marks, have no regular forms worth adding.
    if (word.length < 3 || word.length > 12 || !/^[a-z]+$/.test(word)) continue
    // A word that is already an inflection ("walked", "quickly") gets none of its own:
    // that halves the list, which the engine holds in memory while it is loaded.
    if (/(?:s|ed|ing|ly|ness|ous|ful|est)$/.test(word)) continue
    for (const [form, sounds] of inflections(word, phonemes))
      if (!known.has(form) && !derived.has(form)) derived.set(form, sounds)
  }
  return [...derived].map(([word, sounds]) => `${word} ${sounds}`).join('\n')
}

/**
 * Splits a word the dictionary lacks into dictionary words, fewest pieces
 * first: "worktree" is "work tree". Pieces are at least two letters, so a
 * made-up name still falls through to being spelled.
 */
export function splitIntoWords(word: string, words: ReadonlySet<string>): string[] | null {
  const best: (string[] | null)[] = Array.from({ length: word.length + 1 }, () => null)
  best[0] = []
  for (let end = 2; end <= word.length; end++)
    for (let start = 0; start <= end - 2; start++) {
      const before = best[start]
      if (before === null || before === undefined) continue
      const piece = word.slice(start, end)
      if (!words.has(piece)) continue
      const current = best[end]
      if (current === null || current === undefined || before.length + 1 < current.length)
        best[end] = [...before, piece]
    }
  const found = best[word.length]
  // More than three pieces is no longer a compound: it is noise that happens to parse.
  return found && found.length > 1 && found.length <= 3 ? found : null
}

/**
 * The dictionary word one letter away from an unknown one, for names spelled
 * for effect. Only tried on words of five letters or more, where a single
 * changed letter rarely lands on an unrelated word; the first letter is kept.
 */
export function nearWord(word: string, words: ReadonlySet<string>): string | null {
  if (word.length < 5) return null
  // Sound-alike swaps first, so "kollect" finds "collect" before anything else.
  const swaps: Record<string, string> = { k: 'c', c: 'k', z: 's', s: 'z', f: 'ph', i: 'y', y: 'i' }
  for (let at = 0; at < word.length; at++) {
    const swap = swaps[word[at] ?? '']
    if (swap === undefined) continue
    const candidate = word.slice(0, at) + swap + word.slice(at + 1)
    if (words.has(candidate)) return candidate
  }
  // A doubled letter dropped ("skann" is "skan"). Nothing looser: a different
  // real word said with confidence would mislead more than spelling does.
  for (let at = 1; at < word.length; at++) {
    if (word[at] !== word[at - 1]) continue
    const dropped = word.slice(0, at) + word.slice(at + 1)
    if (words.has(dropped)) return dropped
  }
  return null
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
    // A possessive or a compound is said as the words it is made of.
    const bare = lower.replace(/'s$/, '')
    if (words.has(bare)) return bare
    const pieces = /^[a-z]+$/.test(bare) ? splitIntoWords(bare, words) : null
    if (pieces) return pieces.join(' ')
    // A name one letter away from a real word ("Kollect") is said as that word.
    const near = /^[a-z]+$/.test(bare) ? nearWord(bare, words) : null
    if (near) return near
    spelled.push(word)
    const letters = lower.replace(/'/g, '').split('')
    if (letters.some((letter) => !words.has(letter)))
      throw new Error('Kokoro’s pronunciation dictionary is incomplete. Download the model again.')
    return letters.join(' ')
  })
  return { text: covered, spelled, words: count }
}

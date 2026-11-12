export interface DictationFormatOptions {
  formatText?: boolean
  spokenFormatting?: boolean
  language?: string
  words?: DictationWord[]
}

export interface DictationWord {
  text: string
  t0Ms: number
  t1Ms: number
}

// Capitalize ordinary sentence starters, never guess the casing of a name or identifier.
const starters = new Set(
  (
    'i we you it this that these those the a an my our your there here ' +
    'please can could would should will do does did is are was were have has ' +
    'what why when where who how okay ok well so now also next then however anyway ' +
    'separately on first second third finally hello hi thanks thank yes no ' +
    'run check keep add fix update use open make let review deploy install remove test ' +
    'bonjour salut merci je nous vous il elle les une un ' +
    'hola gracias yo nosotros tengo quiero podemos ' +
    'ich wir du das die der bitte danke hallo ' +
    'olá obrigado obrigada eu nós não ' +
    'привет спасибо я мы это'
  ).split(' '),
)

const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']
const terminal = /[.!?。！？…:;,]$/u
const englishQuestion =
  /^(?:(?:can|could|would|should|will|do|does|did|is|are|was|were|have|has) (?:you|we|i|he|she|it|they|this|that|the)\b|(?:what|why|when|where|who|how) (?:is|are|was|were|do|does|did|can|could|would|should|will|has|have)\b)/i

/** Only finalized speech enters here. No model, network, or interpretation of transcript instructions. */
export function formatDictation(raw: string, options: DictationFormatOptions = {}): string {
  if (!raw.trim()) return raw
  if (options.formatText === false && !options.spokenFormatting) return raw
  // Reserve our masking delimiters; an unexpected transcript is safer left verbatim.
  if (/[\uE000\uE001]/u.test(raw)) return raw
  const saved: string[] = []
  const protect = (value: string): string => {
    saved.push(value)
    return `\uE000${saved.length - 1}\uE001`
  }
  let text = (options.formatText === false ? raw : pauseParagraphs(raw, options.words)).replace(
    /```[\s\S]*?(?:```|$)|`[^`\n]+`|"(?:\\.|[^"\\\n])*"|“[^”\n]+”|‘[^’\n]+’|(?<![\p{L}\p{N}])'(?:\\.|[^'\\\n])*'(?![\p{L}\p{N}])|\b(?:e\.g\.|i\.e\.|Mr\.|Dr\.|Ms\.|vs\.)|[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^\s]+|[a-zA-Z]:[\\/][^\s]+|(?:~?\/|\.\.?\/)[^\s]+|\b[\p{L}\p{N}_-]+(?:[.\\/][\p{L}\p{N}_-]+)+\b|\b(?=[\p{L}\p{N}_-]*\p{L})[\p{L}\p{N}-]*[_\d][\p{L}\p{N}_-]*\b|\b[\p{Ll}]+[\p{Lu}][\p{L}\p{N}]*\b/gu,
    protect,
  )
  text = text.replace(
    /\b((?:variable|identifier|parameter|argument|index|counter|named|called|key|field|property|function|method|class|const|let|var|int)\s+)(i)\b/gi,
    (_match, prefix: string, value: string) => prefix + protect(value),
  )
  text = text.replace(/\bi(?=\s*(?:\+\+|--|[=+*/<>-]))/g, protect)
  if (options.spokenFormatting) text = spokenCommands(text, protect)
  if (options.spokenFormatting)
    text = text
      .replace(/ +([,;:.!?])/g, '$1')
      .replace(/ *\n */g, '\n')
      .replace(/^ +| +$/g, '')
  if (options.formatText !== false) {
    text = text
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
    text = text.replace(/ +([,;:!?。！？])/gu, '$1')
    text = options.spokenFormatting ? text.replace(/^ +| +$/g, '') : text.trim()
    const english = options.language
      ? /^en(?:[-_]|$)/i.test(options.language)
      : /\b(?:you|the|please|could|would|should|hello|okay|thanks)\b|\b(?:i|we) (?:am|are|was|were|have|had|want|need|think|wonder|checked|check|review|reviewed|like|feel|hope|know|use|used|can|will|did|do|don't)\b|\bi['’](?:m|ve|ll|d)\b|\bfirst\b[\s\S]*\bsecond\b/i.test(
          text,
        )
    if (english) {
      text = ordinalList(text)
      text = text.replace(/\bi(?=\b|['’](?:m|ve|ll|d)\b)/g, 'I')
      text = sentenceBoundaries(text)
    }
    text = text
      .split('\n')
      .map((line) => formatLine(line, english, saved))
      .join('\n')
    text = text.replace(/([.!?]) +(?=(?:Separately\b|On another note\b))/g, '$1\n\n')
  }
  return text.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => saved[Number(index)]!)
}

function pauseParagraphs(raw: string, words: DictationWord[] = []): string {
  // Align exact words before using timing data. Unsupported/inconsistent timestamps are ignored.
  const breaks: number[] = []
  const prose = !/[`"“”]/u.test(raw)
  let cursor = 0
  let previous: DictationWord | undefined
  for (const word of words) {
    const value = word.text.trim()
    if (
      !value ||
      !Number.isFinite(word.t0Ms) ||
      !Number.isFinite(word.t1Ms) ||
      word.t0Ms < 0 ||
      word.t1Ms < word.t0Ms
    )
      return raw
    const start = raw.indexOf(value, cursor)
    if (start < 0 || !/^[\s.,;:!?。！？]*$/u.test(raw.slice(cursor, start))) return raw
    if (
      previous &&
      word.t0Ms - previous.t1Ms >= 1800 &&
      /[.!?。！？]$/u.test(raw.slice(Math.max(0, cursor - 1), start).trimEnd()) &&
      start > cursor &&
      // Do not reflow quoted speech or fenced/inline code.
      prose
    )
      breaks.push(start)
    cursor = start + value.length
    previous = word
  }
  if (!/^[\s.,;:!?。！？]*$/u.test(raw.slice(cursor))) return raw
  for (const start of breaks.reverse())
    raw = raw.slice(0, start).trimEnd() + '\n\n' + raw.slice(start)
  return raw
}

/** A formatter error must never turn a successful transcription into lost speech. */
export function finalizeDictation(raw: string, options: DictationFormatOptions = {}): string {
  try {
    const text = formatDictation(raw, options)
    return text.trim() || (options.spokenFormatting && text.includes('\n')) ? text : raw
  } catch {
    return raw
  }
}

function spokenCommands(text: string, protect: (value: string) => string): string {
  let numbered = 0
  return text.replace(
    /\b(literal )?(new paragraph|new line|bullet point|numbered list|next item|end list|full stop|question mark|exclamation mark|comma|colon|semicolon)\b[.,]?/gi,
    (match, literal: string | undefined, command: string, offset: number, source: string) => {
      if (literal) return protect(match.slice(literal.length))
      const line = source.slice(0, offset).trim() ? '\n' : ''
      switch (command.toLowerCase()) {
        case 'new paragraph':
          numbered = 0
          return '\n\n'
        case 'new line':
          return '\n'
        case 'bullet point':
          numbered = 0
          return line + '- '
        case 'numbered list':
          numbered = 1
          return line + '1. '
        case 'next item':
          return numbered ? `${line}${++numbered}. ` : line + '- '
        case 'end list':
          numbered = 0
          return '\n\n'
        case 'full stop':
          return '.'
        case 'question mark':
          return '?'
        case 'exclamation mark':
          return '!'
        case 'comma':
          return ','
        case 'colon':
          return ':'
        default:
          return ';'
      }
    },
  )
}

function ordinalList(text: string): string {
  // Require a list introduction or a first item at the start, plus consecutive ordinals.
  // "At first ... a second opinion" is prose, not a list.
  const first = /\bfirst\b[,:.]?\s+/i.exec(text)
  if (!first) return text
  const leadingBreaks = /^\n+/u.exec(text)?.[0] ?? ''
  const trailingBreaks = /\n+$/u.exec(text)?.[0] ?? ''
  if (/^(?:of all|time|class|name|aid)\b/i.test(text.slice(first.index + first[0].length)))
    return text
  const introduction = text.slice(0, first.index).trim()
  if (
    introduction &&
    !/\b(?:steps|tasks|items|things|todo|to do|checklist|list)\b[^.!?]*[.:]?$/i.test(introduction)
  )
    return text
  const tail = text.slice(first.index)
  const markers = [
    ...tail.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\b[,:.]?\s+/gi),
  ]
  if (
    markers.length < 2 ||
    markers.some(
      (marker, index) =>
        ordinals[index] !== marker[1]!.toLowerCase() ||
        /\b(?:a|the|my|at|per|in|every|each|for|on|of|from|to)\s+$/i.test(
          tail.slice(0, marker.index),
        ),
    )
  )
    return text
  const items = markers.map((marker, index) => {
    const end = markers[index + 1]?.index ?? tail.length
    return `${index + 1}. ${tail.slice(marker.index + marker[0].length, end).trim()}`
  })
  if (items.some((item) => item.split(/\s+/).length < 3)) return text
  return (
    leadingBreaks +
    (introduction ? `${introduction.replace(/[.:]$/, '')}:\n` : '') +
    items.join('\n') +
    trailingBreaks
  )
}

function sentenceBoundaries(text: string): string {
  let sentenceStart = 0
  return text.replace(
    /[.!?]\s+|\n+| +(?=(?:(?:now|also|however|anyway|separately) (?:i|we|you|it|this|the)|on another note\b|(?:can|could|would) (?:you|we)\b))/gi,
    (match, offset: number) => {
      if (/[.!?\n]/.test(match)) {
        sentenceStart = offset + match.length
        return match
      }
      const prior = text.slice(sentenceStart, offset)
      const question = /^(?:can|could|would) /i.test(text.slice(offset + match.length))
      if (
        prior.split(/\s+/).length < (question ? 6 : 8) ||
        /\b(?:and|but|or|because|that|if|when|so|then)$/i.test(prior)
      )
        return match
      sentenceStart = offset + match.length
      return englishQuestion.test(prior) ? '? ' : '. '
    },
  )
}

function formatLine(line: string, english: boolean, saved: string[]): string {
  if (!line.trim()) return line
  // Already-authored Markdown and code retain their structure; lists get only sentence casing.
  if (/^(?:#{1,6} |>|\uE000\d+\uE001$)/u.test(line)) return line
  let result = line.replace(
    /(^\s*(?:[-*] |\d+\. )?|[.!?。！？]\s+)([\p{L}]+)(?=\s|[,!?。！？.]|$)/gu,
    (match, prefix: string, word: string) =>
      starters.has(word) ? prefix + word[0]!.toLocaleUpperCase() + word.slice(1) : match,
  )
  if (english) {
    result = result.replace(
      /(^|[.!?]\s+)(Okay|Ok|Well|However|Also|Separately)(?=\s+\p{L})/gu,
      '$1$2,',
    )
    const body = result.replace(/^\s*(?:[-*] |\d+\. )/, '')
    const last = body.split(/[.!?]\s+/).at(-1)!
    const first = /^[\p{L}]+/u.exec(last)?.[0]?.toLowerCase()
    const protectedEnd = /\uE000(\d+)\uE001$/u.exec(result)
    const literalEnd = protectedEnd ? saved[Number(protectedEnd[1])]! : ''
    const preserveEnd =
      /^([`"“]|[a-zA-Z]:[\\/])|[\\/]|\.(?:tsx?|jsx?|json|md|py|rs|go|cs|html|css|yaml|yml|gguf)$|\.$/u.test(
        literalEnd,
      )
    // Do not punctuate a bare name, path, code fragment, heading, or incomplete clause.
    if (
      first &&
      starters.has(first) &&
      (last.split(/\s+/).length >= 3 || /^(?:hello|hi|thanks|thank)\b/i.test(last)) &&
      !terminal.test(result) &&
      !preserveEnd
    )
      result += englishQuestion.test(last) ? '?' : '.'
  }
  return result
}

/** Join a finalized utterance to a captured draft without gluing adjacent words together. */
export function dictationInsertion(before: string, text: string, after: string): string {
  if (!text.trim()) return text
  const unspaced =
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u
  const left =
    before && !/[\s(/\\]$/u.test(before) && /^[\p{L}\p{N}]/u.test(text) && !unspaced.test(text)
      ? ' '
      : ''
  const right =
    after && !/\s$/u.test(text) && /^[\p{L}\p{N}]/u.test(after) && !unspaced.test(after) ? ' ' : ''
  return left + text + right
}

export function hasDictationText(text: string): boolean {
  return /\S/u.test(text) || /^\n+$/u.test(text)
}

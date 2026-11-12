/** Aria's spoken reply travels separately from markdown in a hidden protocol line. */
const marker = /<!--\s*aria:speak\s+(\{[^\n]*\})\s*-->/g
const MAX_SPOKEN_CHARACTERS = 6000

export function spokenLine(reply: string): string | null {
  for (const match of reply.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '').matchAll(marker)) {
    try {
      const value = JSON.parse(match[1]!) as { text?: unknown }
      if (typeof value.text !== 'string' || value.text.length > MAX_SPOKEN_CHARACTERS) continue
      const line = value.text.trim()
      if (!line || /[`\n\r]|\|.*\||<|>/.test(line)) continue
      return plain(line)
    } catch {
      /* An incomplete streaming marker is not a spoken reply. */
    }
  }
  return null
}

export function writtenReply(reply: string): string {
  return reply
    .replace(marker, '')
    .replace(/<!--\s*aria:speak[\s\S]*$/, '')
    .trim()
}

function sentences(text: string): string[] {
  // Decimal points and domains are part of the sentence, not sentence boundaries.
  return (text.match(/[\s\S]+?(?:[.!?]+(?=\s|$)|$)/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, 'the chat')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(
      /https?:\/\/([^/\s?#]+)[^\s]*/g,
      (url, domain: string) =>
        domain.replace(/[.,!?]+$/, '').replace(/\./g, ' dot ') + (url.match(/[.,!?]+$/)?.[0] ?? ''),
    )
    .replace(/\b[A-Za-z]:[\\/][^\s]+|\b(?:apps|packages|src|docs)\/[\w./-]+/g, 'the file')
    .replace(/\b(?:PR\s*)?#\d+\b/g, 'the change')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'the item')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function speechContent(reply: string): { text: string; structured: boolean } {
  let structured = false
  const text = writtenReply(reply)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, () => {
      structured = true
      return '\n'
    })
    .split(/\r?\n/)
    .flatMap((line) => {
      if (/^\s*\|/.test(line) || /\|.*\|/.test(line) || /^\s*See \[/.test(line)) {
        structured = true
        return []
      }
      // Headings label the written layout; list items often carry the answer.
      if (/^\s*#{1,6}\s/.test(line)) return []
      const item = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim()
      if (!item) return []
      return [/[.!?][*_'"”’]*$/.test(item) ? item : `${item}.`]
    })
    .join('\n')
    .replace(/`[^`]*`/g, () => {
      structured = true
      return 'the details in the chat'
    })
    .replace(/<!--[^]*?-->/g, '')
  return { text: plain(text), structured }
}

function boundedSpeech(text: string, limit: number): string {
  if (text.length <= limit) return text
  const prefix = text.slice(0, limit - 35)
  const boundary = Math.max(
    prefix.lastIndexOf('. '),
    prefix.lastIndexOf('? '),
    prefix.lastIndexOf('! '),
  )
  const cut =
    boundary >= 0 ? prefix.slice(0, boundary + 1) : prefix.slice(0, prefix.lastIndexOf(' ')) + '.'
  return `${cut} More details are in the chat.`
}

/** Read aloud includes useful prose and list details, rather than the automatic summary. */
export function readableReply(reply: string): string {
  const { text, structured } = speechContent(reply)
  return boundedSpeech(
    [text, structured ? 'I put the code and tables in the chat.' : ''].filter(Boolean).join(' '),
    MAX_SPOKEN_CHARACTERS,
  )
}

/** A useful conversational summary, including the explanation and a direct question. */
export function condenseReply(reply: string): string {
  const authored = spokenLine(reply)
  if (authored) return authored
  const { text, structured } = speechContent(reply)
  const all = sentences(text)
  const question = all.findLast(
    (s) =>
      s.endsWith('?') &&
      s.length <= 400 &&
      /\b(?:you|your|want|should|shall|can I|do I|may I|which|would)\b/i.test(s),
  )
  const explanation = [
    ...all.filter((sentence) => sentence !== question).slice(0, 6),
    structured ? 'I put the details in the chat.' : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  const summary = boundedSpeech(explanation, 1800 - (question ? question.length + 1 : 0))
  return [summary, question].filter(Boolean).join(' ')
}

/** Start with a short clause; later requests remain sentence-sized and provider-bounded. */
export function speechChunks(
  text: string,
  limit = 200,
  length = (value: string) => value.length,
): string[] {
  const result: string[] = []
  const append = (part: string) => {
    while (length(part) > limit) {
      let chunk = ''
      for (const word of part.split(/\s+/)) {
        const candidate = chunk ? `${chunk} ${word}` : word
        if (length(candidate) > limit) break
        chunk = candidate
      }
      if (!chunk) throw new Error('A spoken word is too long.')
      result.push(chunk)
      part = part.slice(chunk.length).trim()
    }
    if (part) result.push(part)
  }
  for (const sentence of sentences(text)) {
    let rest = sentence
    if (!result.length) {
      const comma = rest.indexOf(',')
      const words = rest.split(/\s+/)
      const split =
        comma > 0 && comma < 80
          ? comma + 1
          : words.length > 5
            ? words.slice(0, 4).join(' ').length
            : 0
      if (split) {
        append(rest.slice(0, split).trim())
        rest = rest.slice(split).trim()
      }
    }
    append(rest)
  }
  return result
}

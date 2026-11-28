/** Aria's spoken reply travels separately from markdown in a hidden protocol line. */
const marker = /<!--\s*aria:speak\s+(\{[^\n]*\})\s*-->/g
const MAX_SPOKEN_CHARACTERS = 6000

export interface SpokenReply {
  text: string
  tone?: 'warm' | 'cheerful'
}

export function spokenReply(reply: string): SpokenReply | null {
  for (const match of reply.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '').matchAll(marker)) {
    try {
      const value = JSON.parse(match[1]!) as { text?: unknown; tone?: unknown }
      if (typeof value.text !== 'string' || value.text.length > MAX_SPOKEN_CHARACTERS) continue
      const line = value.text.trim()
      if (!line || /[`\n\r]|\|.*\||<|>/.test(line)) continue
      const text = plain(line)
      if (!text) continue
      const tone = value.tone
      return tone === 'warm' || tone === 'cheerful' ? { text, tone } : { text }
    } catch {
      /* An incomplete streaming marker is not a spoken reply. */
    }
  }
  return null
}

export function spokenLine(reply: string): string | null {
  return spokenReply(reply)?.text ?? null
}

export function writtenReply(reply: string): string {
  return reply
    .replace(marker, '')
    .replace(/<!--\s*aria:speak[\s\S]*$/, '')
    .trim()
}

function sentences(text: string): string[] {
  // A period in a title, decimal or domain can belong inside the sentence.
  const boundary =
    /[\s\S]+?(?:(?:(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|e\.g|i\.e))\.|[!?])[.!?]*['"”’)\]]*(?=\s|$)|$)/gi
  return (text.match(boundary) ?? []).map((sentence) => sentence.trim()).filter(Boolean)
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
  const lines = writtenReply(reply)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, () => {
      structured = true
      return '\n\n'
    })
    .replace(/<!--[^]*?-->/g, '')
    .split(/\r?\n/)
  const paragraphs: string[] = []
  let paragraph = ''
  const flush = () => {
    if (paragraph)
      paragraphs.push(/[.!?][*_'"”’)\]]*$/.test(paragraph) ? paragraph : `${paragraph}.`)
    paragraph = ''
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\||\|.*\||^See \[/.test(line)) {
      structured = true
      flush()
      continue
    }
    if (!line || /^#{1,6}\s/.test(line)) {
      flush()
      continue
    }
    const item = /^(?:[-*+]\s+|\d+[.)]\s+|>\s*)(.*)$/.exec(line)
    if (item) flush()
    const text = item?.[1] ?? line
    paragraph = paragraph ? `${paragraph} ${text}` : text
  }
  flush()
  const text = paragraphs.join(' ').replace(/`[^`]*`/g, () => {
    structured = true
    return 'the details in the chat'
  })
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
      /\?['"”’)\]]*$/.test(s) &&
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

/** Keep each sentence intact whenever the provider can take it in one request. */
export function speechChunks(
  text: string,
  limit = 200,
  length = (value: string) => value.length,
): string[] {
  const result: string[] = []
  for (let part of sentences(text)) {
    while (length(part) > limit) {
      let end = 0
      let clause = 0
      for (const word of part.matchAll(/\S+/g)) {
        const boundary = word.index + word[0].length
        if (length(part.slice(0, boundary)) > limit) break
        end = boundary
        if (/[,;:—–]$/.test(word[0])) clause = end
      }
      if (!end) throw new Error('A spoken word is too long.')
      const cut =
        clause && (clause >= end / 2 || length(part.slice(clause).trim()) <= limit) ? clause : end
      result.push(part.slice(0, cut))
      part = part.slice(cut).trim()
    }
    if (part) result.push(part)
  }
  return result
}

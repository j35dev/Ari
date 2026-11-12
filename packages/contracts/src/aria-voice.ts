/** Aria's spoken reply travels separately from markdown in a hidden protocol line. */
const marker = /<!--\s*aria:speak\s+(\{[^\n]*\})\s*-->/g

export function spokenLine(reply: string): string | null {
  for (const match of reply.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '').matchAll(marker)) {
    try {
      const value = JSON.parse(match[1]!) as { text?: unknown }
      if (typeof value.text !== 'string' || value.text.length > 420) continue
      const line = value.text.trim()
      if (!line || /[`\n\r]|\|.*\||<|>/.test(line)) continue
      return sentences(plain(line)).slice(0, 3).join(' ')
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
  return (text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, 'the chat')
    .replace(/\[[^\]]*\]\([^)]*\)/g, 'the chat')
    .replace(/https?:\/\/([^/\s?#]+)[^\s]*/g, '$1')
    .replace(/\b[A-Za-z]:[\\/][^\s]+|\b(?:apps|packages|src|docs)\/[\w./-]+/g, 'the file')
    .replace(/\b(?:PR\s*)?#\d+\b/g, 'the change')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'the item')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Outcome plus a direct question. Structured content is always left in the chat. */
export function condenseReply(reply: string): string {
  const authored = spokenLine(reply)
  if (authored) return authored
  let structured = false
  const text = writtenReply(reply)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, () => {
      structured = true
      return '\n'
    })
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*(?:\||[-*+]\s|\d+[.)]\s|#{1,6}\s|>)/.test(line)) {
        structured = true
        return false
      }
      return true
    })
    .join('\n')
    .replace(/`[^`]*`/g, () => {
      structured = true
      return 'the details in the chat'
    })
    .replace(/<!--[^]*?-->/g, '')
  const all = sentences(plain(text))
  const outcome = all.find((s) => !s.endsWith('?') && s.length <= 220)
  const question = all.find(
    (s) =>
      s.endsWith('?') &&
      s.length <= 180 &&
      /\b(?:you|your|want|should|shall|can I|do I|may I|which|would)\b/i.test(s),
  )
  const result = [
    outcome,
    structured ? 'I put the details in the chat.' : undefined,
    question,
  ].filter(Boolean)
  return result.slice(0, 3).join(' ')
}

/** Start with a short clause; later requests remain sentence-sized and provider-bounded. */
export function speechChunks(text: string, limit = 200): string[] {
  const result: string[] = []
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
        result.push(rest.slice(0, split).trim())
        rest = rest.slice(split).trim()
      }
    }
    while (rest.length > limit) {
      const split = rest.lastIndexOf(' ', limit)
      if (split < 1) throw new Error('A spoken word is too long.')
      result.push(rest.slice(0, split).trim())
      rest = rest.slice(split).trim()
    }
    if (rest) result.push(rest)
  }
  return result
}

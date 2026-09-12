import type { AgentEvent } from '@ari/contracts/agent-event'

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function output(dataBase64: string, mimeType: string, name: string): AgentEvent | null {
  if (!/^image\/[a-z0-9.+-]+$/.test(mimeType) || dataBase64.trim().length === 0) return null
  return { type: 'image-output', dataBase64: dataBase64.replace(/\s/g, ''), mimeType, name }
}

function dataUrl(value: unknown, name: string): AgentEvent | null {
  if (typeof value !== 'string') return null
  const match = DATA_IMAGE.exec(value)
  return match?.[1] && match[2] ? output(match[2], match[1].toLowerCase(), name) : null
}

/** Extracts image blocks from provider tool/content payloads without interpreting arbitrary JSON. */
export function imageOutputEvents(value: unknown, name = 'generated-image'): AgentEvent[] {
  const events: AgentEvent[] = []
  const seen = new Set<string>()

  const add = (event: AgentEvent | null): void => {
    if (event?.type !== 'image-output') return
    const key = `${event.mimeType}:${event.dataBase64}`
    if (!seen.has(key)) {
      seen.add(key)
      events.push(event)
    }
  }

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    const record = recordOf(candidate)
    if (record === null) return

    if (record['type'] === 'image') {
      const source = recordOf(record['source'])
      const mimeType = record['mimeType'] ?? record['mime_type']
      if (typeof record['data'] === 'string' && typeof mimeType === 'string') {
        add(output(record['data'], mimeType, name))
      } else if (
        source?.['type'] === 'base64' &&
        typeof source['data'] === 'string' &&
        typeof source['media_type'] === 'string'
      ) {
        add(output(source['data'], source['media_type'], name))
      }
    }

    add(dataUrl(record['imageUrl'], name))
    add(dataUrl(record['image_url'], name))
    add(dataUrl(recordOf(record['image_url'])?.['url'], name))
    for (const key of ['content', 'contentItems', 'result', 'output']) visit(record[key])
  }

  visit(value)
  return events
}

/** Normalizes the base64 result field of Codex's native image-generation item. */
export function codexImageOutput(result: string, name = 'generated-image.png'): AgentEvent | null {
  return dataUrl(result, name) ?? output(result, 'image/png', name)
}

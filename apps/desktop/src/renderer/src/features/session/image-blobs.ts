import type { JournalEvent } from '@ari/contracts/events'
import type { Message, MessagePart } from '@ari/contracts/message'

/**
 * Tool results can carry whole screenshots as base64 (a Read of a PNG, an MCP
 * screenshot tool). Kept as text, each one sits in the renderer's JavaScript
 * heap for the life of the transcript and is copied again by every consumer;
 * a session that looked at a hundred screenshots held well over 100 MB.
 *
 * On the way into the transcript, each image's bytes move into a Blob (binary,
 * a quarter smaller, outside the JS heap and pageable by Chromium) and the
 * result keeps a `blob:` URL in its place. What renders is unchanged.
 */

/** Smaller images are not worth a Blob; they stay inline. */
const MIN_INLINE_CHARS = 16 * 1024

function decode(data: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** A `blob:` URL for base64 image bytes, or null where Blob URLs are unavailable. */
export function base64ObjectUrl(data: string, mimeType: string): string | null {
  if (typeof URL.createObjectURL !== 'function') return null
  const bytes = decode(data)
  return bytes === null ? null : URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}

/** Identifies image bytes without keeping them: length, MIME type and a 32-bit FNV-1a hash. */
function fingerprint(data: string, mimeType: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${mimeType}:${data.length}:${(hash >>> 0).toString(36)}`
}

/** Blob URLs owned by one transcript; the same bytes always map to the same URL. */
export class ImageBlobs {
  readonly #urls = new Map<string, string>()

  url(data: string, mimeType: string): string | null {
    const key = fingerprint(data, mimeType)
    const known = this.#urls.get(key)
    if (known !== undefined) return known
    const url = base64ObjectUrl(data, mimeType)
    if (url !== null) this.#urls.set(key, url)
    return url
  }

  dispose(): void {
    for (const url of this.#urls.values()) URL.revokeObjectURL(url)
    this.#urls.clear()
  }
}

type Block = Record<string, unknown>

/** Moves one image block's bytes into a Blob; true when it changed. */
function compactBlock(block: Block, blobs: ImageBlobs): boolean {
  if (block['type'] !== 'image') return false
  const source =
    block['source'] !== null && typeof block['source'] === 'object'
      ? (block['source'] as Block)
      : null
  const holder = source ?? block
  const data = holder['data']
  const mimeType = holder['media_type'] ?? holder['mimeType']
  if (typeof data !== 'string' || data.length < MIN_INLINE_CHARS || typeof mimeType !== 'string')
    return false
  const url = blobs.url(data, mimeType)
  if (url === null) return false
  if (source !== null) block['source'] = { type: 'url', url, media_type: mimeType }
  else {
    delete block['data']
    block['url'] = url
  }
  return true
}

function compactResult(resultJson: string, blobs: ImageBlobs): string {
  if (resultJson.length < MIN_INLINE_CHARS || !resultJson.includes('"image"')) return resultJson
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    return resultJson
  }
  const blocks: unknown =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { content?: unknown }).content
      : parsed
  if (!Array.isArray(blocks)) return resultJson
  let changed = false
  for (const block of blocks)
    if (block !== null && typeof block === 'object' && compactBlock(block as Block, blobs))
      changed = true
  return changed ? JSON.stringify(parsed) : resultJson
}

function compactParts(parts: readonly MessagePart[], blobs: ImageBlobs): MessagePart[] | null {
  let changed = false
  const next = parts.map((part) => {
    if (part.type !== 'tool-result') return part
    const resultJson = compactResult(part.resultJson, blobs)
    if (resultJson === part.resultJson) return part
    changed = true
    return { ...part, resultJson }
  })
  return changed ? next : null
}

/** The message with large tool-result images moved into Blobs; the same object when none. */
export function compactMessageImages(message: Message, blobs: ImageBlobs): Message {
  const parts = compactParts(message.parts, blobs)
  return parts === null ? message : { ...message, parts }
}

/** The event with large tool-result images moved into Blobs; the same object when none. */
export function compactEventImages(event: JournalEvent, blobs: ImageBlobs): JournalEvent {
  const record = event as unknown as {
    parts?: readonly MessagePart[]
    message?: { parts?: readonly MessagePart[] }
  }
  if (Array.isArray(record.parts)) {
    const parts = compactParts(record.parts, blobs)
    return parts === null ? event : ({ ...event, parts } as JournalEvent)
  }
  if (record.message && Array.isArray(record.message.parts)) {
    const parts = compactParts(record.message.parts, blobs)
    return parts === null
      ? event
      : ({ ...event, message: { ...record.message, parts } } as unknown as JournalEvent)
  }
  return event
}

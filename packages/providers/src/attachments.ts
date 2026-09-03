import { readFile } from 'node:fs/promises'
import { createLogger } from '@ari/shared/logger'
import type { AdapterSession, SessionAttachment } from './driver'

const log = createLogger('providers:attachments')

/** Staged images for one turn, as resolved to disk paths by the engine. */
export function stagedImagesOf(session: AdapterSession): SessionAttachment[] {
  return [...(session.attachments ?? [])]
}

/** Human byte size for the text fallback (`12.3 KB`, `8.0 MB`). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * Names staged files the agent could not receive as bytes. Empty when every
 * image is readable — the common path appends nothing to the prompt.
 */
export function missingImagesNote(missing: SessionAttachment[]): string {
  if (missing.length === 0) return ''
  const lines = missing.map((img) => `- ${img.name} (${img.mimeType}): staged file missing`)
  return `\n\n[attached images that could not be loaded:]\n${lines.join('\n')}`
}

/**
 * Appends staged-image references to a text prompt for transports without an
 * image channel (one-shot CLIs): the agent can still open each staged file
 * with its own file tools. Returns the prompt untouched when imageless.
 */
export function promptWithAttachments(session: AdapterSession): string {
  const images = stagedImagesOf(session)
  if (images.length === 0) return session.prompt
  const lines = images.map((img) =>
    img.path !== null
      ? `- ${img.name} (${img.mimeType}): ${img.path}`
      : `- ${img.name} (${img.mimeType}): staged file missing`,
  )
  const note = `[attached images — open these files to see them:]\n${lines.join('\n')}`
  return session.prompt.length > 0 ? `${session.prompt}\n\n${note}` : note
}

export interface LoadedImages {
  /** Images whose bytes were read, in session order. */
  loaded: { dataBase64: string; mimeType: string }[]
  /** Staged entries with no readable file (null path or read failure). */
  missing: SessionAttachment[]
}

/**
 * Reads staged bytes for transports with an image channel (ACP, Ari Core,
 * Claude stdin frames). Unreadable entries land in `missing` so the caller
 * can name them in text instead of dropping them silently.
 */
export async function loadImageData(images: SessionAttachment[]): Promise<LoadedImages> {
  const loaded: LoadedImages['loaded'] = []
  const missing: SessionAttachment[] = []
  for (const img of images) {
    if (img.path === null) {
      missing.push(img)
      continue
    }
    try {
      const bytes = await readFile(img.path)
      loaded.push({ dataBase64: bytes.toString('base64'), mimeType: img.mimeType })
    } catch (error) {
      log.warn('staged image unreadable; naming it in text instead', {
        id: img.id,
        error: String(error),
      })
      missing.push(img)
    }
  }
  return { loaded, missing }
}

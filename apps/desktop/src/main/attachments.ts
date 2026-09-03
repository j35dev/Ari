import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type AttachmentRef,
} from '@ari/contracts/attachments'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:attachments')

/** Ids are main-generated; reads reject anything outside this alphabet. */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const MIME_PATTERN = /^image\/[a-z0-9.+-]+$/

/** Extension allowlist for staged files; unknown image types land as .bin. */
const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
}

export interface StagedFileInput {
  name: string
  mimeType: string
  dataBase64: string
}

interface AttachmentSidecar {
  name: string
  mimeType: string
  size: number
  fileName: string
}

/**
 * Disk staging for composer images. The sandboxed renderer cannot hand file
 * paths to the engine, so pasted/dropped bytes are staged here (one content
 * file plus a JSON sidecar per image, both keyed by a main-generated id) and
 * only lightweight refs cross IPC and land in journals.
 */
export class AttachmentStore {
  readonly #dir: string
  #ready: Promise<void> | null = null

  constructor(dir: string) {
    this.#dir = dir
  }

  #ensureDir(): Promise<void> {
    this.#ready ??= mkdir(this.#dir, { recursive: true }).then(() => undefined)
    return this.#ready
  }

  async stage(files: StagedFileInput[]): Promise<AttachmentRef[]> {
    if (files.length === 0 || files.length > MAX_ATTACHMENTS) {
      throw new Error(`expected 1-${MAX_ATTACHMENTS} files, got ${files.length}`)
    }
    await this.#ensureDir()
    const refs: AttachmentRef[] = []
    for (const file of files) {
      refs.push(await this.#stageOne(file))
    }
    return refs
  }

  async #stageOne(file: StagedFileInput): Promise<AttachmentRef> {
    if (!MIME_PATTERN.test(file.mimeType)) {
      throw new Error(`not an image: ${file.name || 'unnamed file'}`)
    }
    const name = file.name.trim().slice(0, 128) || 'image'
    // Buffer.from skips non-base64 characters instead of throwing, so the
    // emptiness and size checks below are the real validation.
    const bytes = Buffer.from(file.dataBase64, 'base64')
    if (bytes.length === 0) throw new Error(`unreadable image data: ${name}`)
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`image too large: ${name}`)
    const id = `att_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const fileName = `${id}${EXTENSION_FOR_MIME[file.mimeType] ?? '.bin'}`
    await writeFile(join(this.#dir, fileName), bytes)
    const sidecar: AttachmentSidecar = { name, mimeType: file.mimeType, size: bytes.length, fileName }
    await writeFile(join(this.#dir, `${id}.json`), JSON.stringify(sidecar))
    return { id, name, mimeType: file.mimeType, size: bytes.length }
  }

  /** Staged bytes as base64 for transcript thumbnails; null when unknown. */
  async read(id: string): Promise<{
    name: string
    mimeType: string
    size: number
    dataBase64: string
  } | null> {
    const fileName = await this.#sidecarFileName(id)
    if (fileName === null) return null
    try {
      const bytes = await readFile(join(this.#dir, fileName))
      const sidecar = await this.#readSidecar(id)
      if (sidecar === null) return null
      return {
        name: sidecar.name,
        mimeType: sidecar.mimeType,
        size: bytes.length,
        dataBase64: bytes.toString('base64'),
      }
    } catch (error) {
      log.warn('staged attachment unreadable', { id, error: String(error) })
      return null
    }
  }

  /** Disk path for an attachment id, or null when unknown. */
  async pathFor(id: string): Promise<string | null> {
    const fileName = await this.#sidecarFileName(id)
    return fileName === null ? null : join(this.#dir, fileName)
  }

  async #readSidecar(id: string): Promise<AttachmentSidecar | null> {
    if (!ATTACHMENT_ID_PATTERN.test(id)) return null
    await this.#ensureDir()
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.#dir, `${id}.json`), 'utf8'))
      const record = parsed as Partial<AttachmentSidecar>
      if (
        typeof record.name !== 'string' ||
        typeof record.mimeType !== 'string' ||
        typeof record.size !== 'number' ||
        typeof record.fileName !== 'string'
      ) {
        return null
      }
      return { name: record.name, mimeType: record.mimeType, size: record.size, fileName: record.fileName }
    } catch {
      return null
    }
  }

  /** Sidecar-declared content filename, jail-checked to a bare filename. */
  async #sidecarFileName(id: string): Promise<string | null> {
    const sidecar = await this.#readSidecar(id)
    if (sidecar === null) return null
    const { fileName } = sidecar
    if (
      fileName.length === 0 ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..')
    ) {
      return null
    }
    return fileName
  }
}

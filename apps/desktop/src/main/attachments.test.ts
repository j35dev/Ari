import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES } from '@ari/contracts/attachments'
import { AttachmentStore } from './attachments'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('AttachmentStore', () => {
  let dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
    dirs = []
  })

  async function store(): Promise<AttachmentStore> {
    const dir = await mkdtemp(join(tmpdir(), 'ari-attachments-'))
    dirs.push(dir)
    return new AttachmentStore(join(dir, 'attachments'))
  }

  it('stages images and reads them back', async () => {
    const attachments = await store()
    const refs = await attachments.stage([{ name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_BASE64 }])
    expect(refs).toHaveLength(1)
    const ref = refs[0]
    if (!ref) throw new Error('expected a ref')
    expect(ref.name).toBe('shot.png')
    expect(ref.mimeType).toBe('image/png')
    expect(ref.size).toBeGreaterThan(0)

    const read = await attachments.read(ref.id)
    expect(read).toMatchObject({ name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_BASE64 })

    const path = await attachments.pathFor(ref.id)
    expect(typeof path).toBe('string')
    expect(path).toContain(ref.id)
  })

  it('rejects non-image payloads', async () => {
    const attachments = await store()
    await expect(
      attachments.stage([{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }]),
    ).rejects.toThrow('not an image')
  })

  it('rejects oversized images', async () => {
    const attachments = await store()
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')
    await expect(
      attachments.stage([{ name: 'huge.png', mimeType: 'image/png', dataBase64: oversized }]),
    ).rejects.toThrow('too large')
  })

  it('returns null for unknown or hostile ids', async () => {
    const attachments = await store()
    expect(await attachments.read('att_missing')).toBeNull()
    expect(await attachments.pathFor('att_missing')).toBeNull()
    expect(await attachments.read('../escape')).toBeNull()
    expect(await attachments.pathFor('..\\escape')).toBeNull()
  })
})

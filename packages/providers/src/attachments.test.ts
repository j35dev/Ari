import { describe, expect, it, vi } from 'vitest'
import {
  formatAttachmentSize,
  loadImageData,
  missingImagesNote,
  promptWithAttachments,
  stagedImagesOf,
} from './attachments'
import type { AdapterSession } from './driver'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

const session = (overrides: Partial<AdapterSession> = {}): AdapterSession => ({
  sessionId: 'sess_1',
  workspacePath: '/repo',
  prompt: 'look at this',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
  ...overrides,
})

describe('provider attachments', () => {
  it('returns the prompt untouched when imageless', () => {
    expect(promptWithAttachments(session())).toBe('look at this')
    expect(stagedImagesOf(session())).toEqual([])
    expect(missingImagesNote([])).toBe('')
  })

  it('references staged files so file-tool agents can open them', () => {
    const prompt = promptWithAttachments(
      session({
        prompt: '',
        attachments: [{ id: 'a1', name: 'shot.png', mimeType: 'image/png', path: '/stage/a1.png' }],
      }),
    )
    expect(prompt).toContain('shot.png')
    expect(prompt).toContain('/stage/a1.png')
    expect(prompt).not.toContain('\n\n\n')
  })

  it('names missing files instead of inventing paths', () => {
    const prompt = promptWithAttachments(
      session({
        attachments: [{ id: 'a1', name: 'gone.png', mimeType: 'image/png', path: null }],
      }),
    )
    expect(prompt).toContain('gone.png')
    expect(prompt).toContain('staged file missing')
  })

  it('loads bytes for image-channel transports and reports the rest', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from('bytes'))
    vi.mocked(readFile).mockRejectedValueOnce(new Error('gone'))
    const result = await loadImageData([
      { id: 'a1', name: 'a.png', mimeType: 'image/png', path: '/stage/a1.png' },
      { id: 'a2', name: 'b.png', mimeType: 'image/png', path: '/stage/a2.png' },
      { id: 'a3', name: 'c.png', mimeType: 'image/png', path: null },
    ])
    expect(result.loaded).toEqual([
      { dataBase64: Buffer.from('bytes').toString('base64'), mimeType: 'image/png' },
    ])
    expect(result.missing.map((m) => m.id)).toEqual(['a2', 'a3'])
    expect(missingImagesNote(result.missing)).toContain('b.png')
  })

  it('formats byte sizes for the fallback note', () => {
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(2048)).toBe('2.0 KB')
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

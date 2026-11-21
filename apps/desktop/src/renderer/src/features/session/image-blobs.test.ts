import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { compactEventImages, ImageBlobs } from './image-blobs'

// A large-enough base64 payload; its bytes do not have to be a real PNG.
const DATA = btoa('x'.repeat(20_000))

function toolResult(resultJson: string): JournalEvent {
  return {
    type: 'assistant.parts.appended',
    sessionId: 's',
    seq: 1,
    at: 1,
    messageId: 'm',
    parts: [{ type: 'tool-result', callId: 'c', resultJson, isError: false }],
  } as unknown as JournalEvent
}

function resultOf(event: JournalEvent): string {
  return (event as unknown as { parts: { resultJson: string }[] }).parts[0]!.resultJson
}

describe('compactEventImages', () => {
  let created = 0
  const revoked: string[] = []
  beforeEach(() => {
    created = 0
    revoked.length = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:ari/${++created}`),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('moves a large Anthropic image block into a Blob URL and keeps everything else', () => {
    const blobs = new ImageBlobs()
    const json = JSON.stringify([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } },
      { type: 'text', text: 'caption' },
    ])
    const compacted = resultOf(compactEventImages(toolResult(json), blobs))
    expect(compacted).not.toContain(DATA)
    expect(JSON.parse(compacted)).toEqual([
      { type: 'image', source: { type: 'url', url: 'blob:ari/1', media_type: 'image/png' } },
      { type: 'text', text: 'caption' },
    ])
  })

  it('handles MCP content blocks and reuses one URL for the same bytes', () => {
    const blobs = new ImageBlobs()
    const json = JSON.stringify({
      content: [{ type: 'image', mimeType: 'image/jpeg', data: DATA }],
    })
    const first = resultOf(compactEventImages(toolResult(json), blobs))
    const again = resultOf(compactEventImages(toolResult(json), blobs))
    expect(JSON.parse(first)).toEqual({
      content: [{ type: 'image', mimeType: 'image/jpeg', url: 'blob:ari/1' }],
    })
    // A replay of the same event compares equal and allocates nothing new.
    expect(again).toBe(first)
    expect(created).toBe(1)
  })

  it('leaves small images, text results and malformed JSON untouched', () => {
    const blobs = new ImageBlobs()
    const small = toolResult(
      JSON.stringify([{ type: 'image', source: { media_type: 'image/png', data: 'aGk=' } }]),
    )
    const text = toolResult(JSON.stringify({ output: 'x'.repeat(30_000), note: 'image' }))
    const broken = toolResult(`[{"type":"image" ${'x'.repeat(30_000)}`)
    for (const event of [small, text, broken]) expect(compactEventImages(event, blobs)).toBe(event)
    expect(created).toBe(0)
  })

  it('revokes its URLs when the transcript goes away', () => {
    const blobs = new ImageBlobs()
    compactEventImages(
      toolResult(
        JSON.stringify([{ type: 'image', source: { media_type: 'image/png', data: DATA } }]),
      ),
      blobs,
    )
    blobs.dispose()
    expect(revoked).toEqual(['blob:ari/1'])
  })
})

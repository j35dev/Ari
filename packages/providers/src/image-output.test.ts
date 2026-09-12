import { describe, expect, it } from 'vitest'
import { codexImageOutput, imageOutputEvents } from './image-output'

describe('provider image output', () => {
  it('extracts MCP and Anthropic image blocks and deduplicates repeated content', () => {
    expect(
      imageOutputEvents({
        content: [
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'anBn' },
          },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      }),
    ).toEqual([
      { type: 'image-output', dataBase64: 'aGk=', mimeType: 'image/png', name: 'generated-image' },
      { type: 'image-output', dataBase64: 'anBn', mimeType: 'image/jpeg', name: 'generated-image' },
    ])
  })

  it('extracts data URLs from dynamic tool content', () => {
    expect(
      imageOutputEvents({
        contentItems: [{ type: 'inputImage', imageUrl: 'data:image/webp;base64,d2VicA==' }],
      }),
    ).toEqual([
      {
        type: 'image-output',
        dataBase64: 'd2VicA==',
        mimeType: 'image/webp',
        name: 'generated-image',
      },
    ])
  })

  it('normalizes a native Codex image-generation result', () => {
    expect(codexImageOutput('cG5n')).toEqual({
      type: 'image-output',
      dataBase64: 'cG5n',
      mimeType: 'image/png',
      name: 'generated-image.png',
    })
  })
})

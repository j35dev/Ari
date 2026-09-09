import { describe, expect, it } from 'vitest'
import { classifyYoutubeUrl, youtubePlaylistFromDump, youtubeTrackFromDump } from './focus-youtube'

describe('classifyYoutubeUrl', () => {
  it('detects songs vs playlists without a type picker', () => {
    expect(classifyYoutubeUrl('https://www.youtube.com/watch?v=abc')).toBe('track')
    expect(classifyYoutubeUrl('https://youtu.be/abc')).toBe('track')
    expect(classifyYoutubeUrl('https://music.youtube.com/watch?v=abc&list=PLxx')).toBe('track')
    expect(classifyYoutubeUrl('https://www.youtube.com/playlist?list=PLxx')).toBe('playlist')
    expect(classifyYoutubeUrl('https://music.youtube.com/playlist?list=PLxx')).toBe('playlist')
    expect(classifyYoutubeUrl('https://example.com/watch?v=abc')).toBeNull()
  })
})

describe('youtube dumps', () => {
  it('maps title/artist/artwork from a video dump', () => {
    expect(
      youtubeTrackFromDump({
        title: 'Nightcall',
        artist: 'Kavinsky',
        webpage_url: 'https://www.youtube.com/watch?v=abc',
        thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
        duration: 255,
      }),
    ).toMatchObject({
      title: 'Nightcall',
      artist: 'Kavinsky',
      sourceUrl: 'https://www.youtube.com/watch?v=abc',
      durationMs: 255_000,
    })
  })

  it('maps flat playlist entries', () => {
    const parsed = youtubePlaylistFromDump({
      title: 'Coding Mix',
      entries: [
        { title: 'Nightcall', id: 'abc' },
        { title: 'Midnight City', webpage_url: 'https://www.youtube.com/watch?v=def' },
      ],
    })
    expect(parsed?.name).toBe('Coding Mix')
    expect(parsed?.tracks).toHaveLength(2)
    expect(parsed?.tracks[0]?.id).toContain('abc')
  })
})

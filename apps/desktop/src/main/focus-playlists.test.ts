import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFocusPlaylistStore, FOCUS_PLAYLISTS_FILE } from './focus-playlists'

describe('createFocusPlaylistStore', () => {
  it('creates, renames, updates, and removes playlists on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-fpl-'))
    try {
      const store = createFocusPlaylistStore(dir)
      const created = await store.create('Coding Bangers', [
        {
          id: 'https://www.youtube.com/watch?v=abc',
          title: 'Nightcall',
          artist: 'Kavinsky',
          station: '',
        },
      ])
      expect(created.name).toBe('Coding Bangers')
      expect((await store.list())[0]?.tracks[0]?.title).toBe('Nightcall')
      await store.rename(created.id, 'Night drives')
      await store.replaceTracks(created.id, [
        {
          id: 'https://www.youtube.com/watch?v=def',
          title: 'Midnight City',
          artist: 'M83',
          station: '',
        },
      ])
      const listed = await store.list()
      expect(listed[0]?.name).toBe('Night drives')
      expect(listed[0]?.tracks[0]?.title).toBe('Midnight City')
      await expect(store.remove(created.id)).resolves.toBe(true)
      await expect(store.list()).resolves.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates tracks, identical creates, and legacy duplicate playlists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-fpl-'))
    const track = {
      id: 'video-id',
      title: 'Nightcall',
      artist: 'Kavinsky',
      station: '',
      sourceUrl: 'https://youtube.com/watch?v=abc',
    }
    try {
      await writeFile(
        join(dir, FOCUS_PLAYLISTS_FILE),
        JSON.stringify({
          playlists: [
            { id: 'first', name: 'Night drive', tracks: [track, track] },
            { id: 'duplicate', name: 'Night drive', tracks: [track] },
          ],
        }),
      )
      const store = createFocusPlaylistStore(dir)
      await expect(store.list()).resolves.toEqual([
        { id: 'first', name: 'Night drive', tracks: [track] },
      ])
      await expect(
        Promise.all([store.create('Night drive', [track]), store.create('Night drive', [track])]),
      ).resolves.toEqual([
        { id: 'first', name: 'Night drive', tracks: [track] },
        { id: 'first', name: 'Night drive', tracks: [track] },
      ])
      await expect(store.list()).resolves.toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

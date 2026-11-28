// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openLocalMedia } from './local-media'

describe('openLocalMedia', () => {
  const openPath = vi.fn<(path: string) => Promise<string>>()
  let folder: string

  beforeEach(async () => {
    openPath.mockReset().mockResolvedValue('')
    folder = await mkdtemp(join(tmpdir(), 'ari-media-'))
  })

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  it('opens a regular file with spaces from a Markdown target or file URL', async () => {
    const file = join(folder, 'Expression Demo #1.WAV')
    await writeFile(file, '')
    expect(await openLocalMedia(encodeURI(file), openPath)).toEqual({ opened: true })
    expect(await openLocalMedia(pathToFileURL(file).href, openPath)).toEqual({ opened: true })
    expect(openPath.mock.calls).toEqual([[await realpath(file)], [await realpath(file)]])
  })

  it('rejects unsupported, relative and network targets before reaching the OS opener', async () => {
    for (const path of [
      join(folder, 'demo.exe'),
      join(folder, 'demo.wav:stream.wav'),
      'demo.wav',
      'https://example.com/demo.wav',
      'file://server/share/demo.wav',
      '//server/share/demo.wav',
    ]) {
      expect((await openLocalMedia(path, openPath)).opened).toBe(false)
    }
    expect(openPath).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a media link resolved to a non-media file',
    async () => {
      const script = join(folder, 'script.sh')
      const link = join(folder, 'demo.wav')
      await writeFile(script, '')
      await symlink(script, link)
      expect((await openLocalMedia(link, openPath)).opened).toBe(false)
      expect(openPath).not.toHaveBeenCalled()
    },
  )

  it('reports a missing file or directory without asking the OS to open it', async () => {
    const directory = join(folder, 'directory.wav')
    await mkdir(directory)
    expect(await openLocalMedia(join(folder, 'missing.wav'), openPath)).toMatchObject({
      opened: false,
      reason: expect.stringContaining('could not be found'),
    })
    expect((await openLocalMedia(directory, openPath)).opened).toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('returns the reason the OS opener failed', async () => {
    const file = join(folder, 'demo.wav')
    await writeFile(file, '')
    openPath.mockResolvedValue('No app is associated with this file.')
    expect(await openLocalMedia(file, openPath)).toEqual({
      opened: false,
      reason: 'No app is associated with this file.',
    })
  })
})

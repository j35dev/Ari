// @vitest-environment node
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openLocalFileLink } from './local-file-link'

describe('openLocalFileLink', () => {
  const actions = {
    openPath: vi.fn<(path: string) => Promise<string>>(),
    showItemInFolder: vi.fn<(path: string) => void>(),
  }
  let folder: string
  const noWorkspace = vi.fn(async () => null)
  const workspace = async () => folder

  beforeEach(async () => {
    actions.openPath.mockReset().mockResolvedValue('')
    actions.showItemInFolder.mockReset()
    noWorkspace.mockClear()
    folder = await mkdtemp(join(tmpdir(), 'ari-file-link-'))
  })

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  it('opens absolute paths and file URLs without looking up a workspace', async () => {
    const file = join(folder, 'Expression Demo #1.WAV')
    await writeFile(file, '')
    expect(await openLocalFileLink(encodeURI(file), noWorkspace, actions)).toEqual({ opened: true })
    expect(await openLocalFileLink(pathToFileURL(file).href, noWorkspace, actions)).toEqual({
      opened: true,
    })
    expect(noWorkspace).not.toHaveBeenCalled()
    expect(actions.openPath.mock.calls).toEqual([[await realpath(file)], [await realpath(file)]])
  })

  it.each([
    ['Brief #1.pdf', 'reports/Brief%20%231.pdf'],
    ['Summary.html', 'reports/Summary.html#totals'],
    ['Notes.docx', 'reports/Notes.docx'],
    ['Cover.png', 'reports/Cover.png'],
    ['Build.zip', 'reports/Build.zip'],
  ])('opens %s in the local session workspace', async (name, target) => {
    await mkdir(join(folder, 'reports'))
    const path = join(folder, 'reports', name)
    await writeFile(path, '')
    expect(await openLocalFileLink(target, workspace, actions)).toEqual({ opened: true })
    expect(actions.openPath).toHaveBeenLastCalledWith(await realpath(path))
  })

  it('sends folders to the file manager and reveals executable-like files', async () => {
    const directory = join(folder, 'Draft exports')
    await mkdir(directory)
    expect(await openLocalFileLink('./Draft%20exports/', workspace, actions)).toEqual({
      opened: true,
    })
    const folderAction = process.platform === 'darwin' ? actions.showItemInFolder : actions.openPath
    expect(folderAction).toHaveBeenCalledWith(await realpath(directory))
    actions.openPath.mockClear()
    for (const file of [
      'Run.exe',
      'Run.cmd',
      'Run.lnk',
      'Open.url',
      'launch.desktop',
      'Unknown.artifact',
    ]) {
      const path = join(folder, file)
      await writeFile(path, '')
      expect(await openLocalFileLink(file, workspace, actions)).toEqual({ opened: true })
      expect(actions.showItemInFolder).toHaveBeenLastCalledWith(await realpath(path))
    }
    expect(actions.openPath).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'uses the canonical file and reveals executable content',
    async () => {
      const program = join(folder, 'run')
      await writeFile(program, '')
      await symlink(program, join(folder, 'cover.png'))
      expect(await openLocalFileLink('cover.png', workspace, actions)).toEqual({ opened: true })
      expect(actions.showItemInFolder).toHaveBeenLastCalledWith(await realpath(program))

      const executable = join(folder, 'executable.txt')
      await writeFile(executable, '')
      await chmod(executable, 0o755)
      expect(await openLocalFileLink('executable.txt', workspace, actions)).toEqual({
        opened: true,
      })
      expect(actions.showItemInFolder).toHaveBeenLastCalledWith(await realpath(executable))
      expect(actions.openPath).not.toHaveBeenCalled()
    },
  )

  it.each([
    'https://example.com/demo.pdf',
    'file://server/share/demo.pdf',
    'file:////server/share/demo.pdf',
    '//server/share/demo.pdf',
    '%5C%5Cserver%5Cshare%5Cdemo.pdf',
    'C:demo.pdf',
    'C:/Demo/file.pdf:stream.txt',
    'src/app.ts:12',
    'src/app.ts#L12-L18',
  ])('rejects %s before workspace lookup or OS dispatch', async (target) => {
    expect((await openLocalFileLink(target, noWorkspace, actions)).opened).toBe(false)
    expect(noWorkspace).not.toHaveBeenCalled()
    expect(actions.openPath).not.toHaveBeenCalled()
    expect(actions.showItemInFolder).not.toHaveBeenCalled()
  })

  it('reports missing paths, unavailable workspaces and native errors', async () => {
    expect(await openLocalFileLink('missing.pdf', workspace, actions)).toMatchObject({
      opened: false,
      reason: expect.stringContaining('could not be found'),
    })
    expect(await openLocalFileLink('report.pdf', noWorkspace, actions)).toMatchObject({
      opened: false,
      reason: expect.stringContaining('workspace is unavailable'),
    })
    const file = join(folder, 'report.pdf')
    await writeFile(file, '')
    actions.openPath.mockResolvedValue('No app is associated with this file.')
    expect(await openLocalFileLink('report.pdf', workspace, actions)).toEqual({
      opened: false,
      reason: 'No app is associated with this file.',
    })
  })
})

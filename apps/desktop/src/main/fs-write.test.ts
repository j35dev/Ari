import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FS_WRITE_MAX_BYTES, writeTextFile } from './fs-write'

const dirs: string[] = []

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ari-write-'))
  dirs.push(root)
  return root
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('writeTextFile', () => {
  it('writes a file inside a registered project folder and reports bytes', async () => {
    const project = await makeProject()
    const target = join(project, 'notes.txt')

    const bytesWritten = await writeTextFile({ path: target, content: 'héllo' }, [project])

    expect(bytesWritten).toBe(Buffer.byteLength('héllo', 'utf8'))
    expect(await readFile(target, 'utf8')).toBe('héllo')
  })

  it('writes nested paths and creates the file when missing', async () => {
    const project = await makeProject()
    await mkdir(join(project, 'src'), { recursive: true })

    await writeTextFile({ path: join(project, 'src', 'new.ts'), content: 'export {}\n' }, [project])

    expect(await readFile(join(project, 'src', 'new.ts'), 'utf8')).toBe('export {}\n')
  })

  it('replaces an existing file without leaving temp files behind', async () => {
    const project = await makeProject()
    const target = join(project, 'existing.txt')
    await writeFile(target, 'old', 'utf8')

    await writeTextFile({ path: target, content: 'new' }, [project])

    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(project)).toEqual(['existing.txt'])
  })

  it('rejects paths escaping every registered project folder', async () => {
    const project = await makeProject()
    const outside = await makeProject()

    await expect(
      writeTextFile({ path: join(outside, 'evil.txt'), content: 'x' }, [project]),
    ).rejects.toThrow('path escapes registered project folders')

    await expect(
      writeTextFile(
        { path: join(project, '..', 'sibling.txt'), content: 'x' },
        [project],
      ),
    ).rejects.toThrow('path escapes registered project folders')
    await expect(readFile(join(outside, 'evil.txt'), 'utf8')).rejects.toThrow()
  })

  it('rejects symlinked targets that resolve outside the jail', async () => {
    if (process.platform === 'win32') return // symlink creation needs privileges
    const project = await makeProject()
    const outside = await makeProject()
    const link = join(project, 'door.md')
    await symlink(join(outside, 'real.md'), link)

    await expect(writeTextFile({ path: link, content: 'x' }, [project])).rejects.toThrow(
      'path escapes registered project folders',
    )
    await expect(readFile(join(outside, 'real.md'), 'utf8')).rejects.toThrow()
  })

  it('rejects payloads over the byte cap', async () => {
    const project = await makeProject()

    await expect(
      writeTextFile({ path: join(project, 'big.txt'), content: 'a'.repeat(FS_WRITE_MAX_BYTES + 1) }, [
        project,
      ]),
    ).rejects.toThrow('write cap')
    await expect(readdir(project)).resolves.toEqual([])
  })

  it('rejects NUL-bearing binary content', async () => {
    const project = await makeProject()

    await expect(
      writeTextFile({ path: join(project, 'blob.bin'), content: 'ok\0nope' }, [project]),
    ).rejects.toThrow('binary content')
    await expect(readdir(project)).resolves.toEqual([])
  })

  it('refuses writes when no projects are registered', async () => {
    const anywhere = await makeProject()
    await expect(writeTextFile({ path: anywhere, content: 'x' }, [])).rejects.toThrow(
      'no registered project folders',
    )
  })
})

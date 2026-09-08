import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveInsideRoots } from './path-jail'

const dirs: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ari-jail-'))
  dirs.push(root)
  return root
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('resolveInsideRoots', () => {
  it('resolves a path inside a registered root', async () => {
    const project = await makeRoot()
    const target = join(project, 'notes.txt')
    await writeFile(target, 'hi', 'utf8')

    await expect(resolveInsideRoots(resolve(target), [project])).resolves.toBe(resolve(target))
  })

  it('rejects paths escaping every registered root', async () => {
    const project = await makeRoot()
    const outside = await makeRoot()

    await expect(resolveInsideRoots(resolve(join(outside, 'evil.txt')), [project])).rejects.toThrow(
      'path escapes registered project folders',
    )
    await expect(
      resolveInsideRoots(resolve(join(project, '..', 'sibling.txt')), [project]),
    ).rejects.toThrow('path escapes registered project folders')
  })

  it('rejects symlinks that resolve outside the jail', async () => {
    if (process.platform === 'win32') return // symlink creation needs privileges
    const project = await makeRoot()
    const outside = await makeRoot()
    const secret = join(outside, 'real.md')
    await writeFile(secret, 'top secret', 'utf8')
    const link = join(project, 'door.md')
    await symlink(secret, link)

    await expect(resolveInsideRoots(resolve(link), [project])).rejects.toThrow(
      'path escapes registered project folders',
    )
  })

  it('refuses dangling symlinks whose target is unknowable', async () => {
    if (process.platform === 'win32') return // symlink creation needs privileges
    const project = await makeRoot()
    const link = join(project, 'ghost.md')
    await symlink(join(project, 'never-existed.md'), link)

    await expect(resolveInsideRoots(resolve(link), [project])).rejects.toThrow(
      'path escapes registered project folders',
    )
  })

  it('allows a genuinely missing file inside the jail via its parent', async () => {
    const project = await makeRoot()

    await expect(
      resolveInsideRoots(resolve(join(project, 'missing.txt')), [project]),
    ).resolves.toBe(resolve(join(project, 'missing.txt')))
  })

  it('refuses writes when no projects are registered', async () => {
    const anywhere = await makeRoot()

    await expect(resolveInsideRoots(resolve(anywhere), [])).rejects.toThrow(
      'no registered project folders',
    )
  })
})

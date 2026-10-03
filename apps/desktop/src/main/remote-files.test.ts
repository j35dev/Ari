import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { queryRemoteFiles } from './remote-files'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ari-remote-files-'))
  roots.push(root)
  return root
}

describe('remote workspace files', () => {
  it('paginates directory entries and reads bounded UTF-8 text', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'readme.md'), 'Hello, 世界')
    await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1')
    expect(await queryRemoteFiles(root, { op: 'files.list', path: '', limit: 1 })).toMatchObject({
      entries: [{ name: 'readme.md', kind: 'file' }],
      nextCursor: 'readme.md',
      error: null,
    })
    expect(
      await queryRemoteFiles(root, { op: 'files.list', path: '', cursor: 'readme.md' }),
    ).toMatchObject({
      entries: [{ name: 'src', kind: 'directory', size: null }],
      nextCursor: null,
    })
    expect(await queryRemoteFiles(root, { op: 'files.read', path: 'readme.md' })).toMatchObject({
      path: 'readme.md',
      kind: 'text',
      content: 'Hello, 世界',
      error: null,
    })
    expect(await queryRemoteFiles(root, { op: 'files.list', path: 'src' })).toMatchObject({
      entries: [{ path: 'src/app.ts' }],
    })
  })

  it('returns metadata only for binary, invalid UTF-8 and oversized files', async () => {
    const root = await workspace()
    for (const [name, bytes] of [
      ['binary', Buffer.from([0, 1])],
      ['invalid', Buffer.from([255, 254])],
      ['large', Buffer.alloc(256 * 1024 + 1, 65)],
    ] as const) {
      await writeFile(join(root, name), bytes)
      expect(await queryRemoteFiles(root, { op: 'files.read', path: name })).toMatchObject({
        kind: name === 'large' ? 'too-large' : 'binary',
        size: bytes.length,
        content: null,
        error: null,
      })
    }
  })

  it('refuses traversal, absolute paths, Windows aliases, credentials, and directories read as files', async () => {
    const root = await workspace()
    await writeFile(join(root, '.env'), 'SECRET')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'git metadata')
    await writeFile(join(root, 'server.pem'), 'private key')
    for (const path of [
      '../outside',
      '/outside',
      'C:/Windows',
      'src\\file',
      'file:stream',
      '.git./config',
      '.git /config',
      '.env ',
      'auth.json.',
      'NUL',
      '.env',
      '.git/config',
      'server.pem',
      '',
    ]) {
      expect(await queryRemoteFiles(root, { op: 'files.read', path })).toMatchObject({
        kind: null,
        content: null,
        error: expect.any(String) as unknown,
      })
    }
    expect(await queryRemoteFiles(root, { op: 'files.list', path: '' })).toMatchObject({
      entries: [],
      error: null,
    })
  })

  it('refuses symlinked files and junctions even when they target the workspace', async () => {
    const root = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'safe.txt'), 'inside')
    await symlink(outside, join(root, 'outside'), 'junction')
    await symlink(join(root, 'real'), join(root, 'alias'), 'junction')
    for (const path of ['outside/secret.txt', 'alias/safe.txt']) {
      expect(await queryRemoteFiles(root, { op: 'files.read', path })).toMatchObject({
        content: null,
        error: expect.any(String) as unknown,
      })
    }
    expect(await queryRemoteFiles(root, { op: 'files.list', path: '' })).toMatchObject({
      entries: [{ name: 'real' }],
    })
  })

  it('bounds wide directories instead of returning an incomplete tree', async () => {
    const root = await workspace()
    for (let i = 0; i <= 2000; i += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 2001 - i) }, (_, offset) =>
          writeFile(join(root, `entry-${i + offset}`), ''),
        ),
      )
    }
    expect(await queryRemoteFiles(root, { op: 'files.list', path: '' })).toMatchObject({
      entries: [],
      error: expect.stringContaining('2,000') as unknown,
    })
  }, 30_000)
})

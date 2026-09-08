import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findTool } from './tools'

describe('write tool path jail', () => {
  it.each(['new.txt', 'nested/new.txt'])(
    'rejects a missing target through an outside directory link: %s',
    async (target) => {
      const dir = await mkdtemp(join(tmpdir(), 'ari-write-jail-'))
      try {
        const workspacePath = join(dir, 'workspace')
        const outside = join(dir, 'outside')
        await mkdir(workspacePath)
        await mkdir(outside)
        await symlink(outside, join(workspacePath, 'link'), 'junction')

        await expect(
          findTool('write')!.execute(
            { path: `link/${target}`, content: 'must stay inside' },
            { workspacePath, permissionMode: 'full' },
          ),
        ).rejects.toThrow(/escapes workspace/)
        await expect(readFile(join(outside, target))).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
  )

  it('allows normal nested writes and links that resolve inside the workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-write-jail-'))
    try {
      const workspacePath = join(dir, 'workspace')
      const internal = join(workspacePath, 'internal')
      await mkdir(internal, { recursive: true })
      await symlink(internal, join(workspacePath, 'link'), 'junction')
      const tool = findTool('write')!

      await expect(
        tool.execute(
          { path: 'nested/normal.txt', content: 'normal' },
          { workspacePath, permissionMode: 'full' },
        ),
      ).resolves.toContain('Wrote')
      await expect(
        tool.execute(
          { path: 'link/through-link.txt', content: 'internal' },
          { workspacePath, permissionMode: 'full' },
        ),
      ).resolves.toContain('Wrote')
      await expect(readFile(join(workspacePath, 'nested/normal.txt'), 'utf8')).resolves.toBe('normal')
      await expect(readFile(join(internal, 'through-link.txt'), 'utf8')).resolves.toBe('internal')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('rejects existing targets outside the workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-write-jail-'))
    try {
      const workspacePath = join(dir, 'workspace')
      const outside = join(dir, 'outside')
      await mkdir(workspacePath)
      await mkdir(outside)
      await writeFile(join(outside, 'existing.txt'), 'protected')
      await symlink(outside, join(workspacePath, 'link'), 'junction')

      await expect(
        findTool('write')!.execute(
          { path: 'link/existing.txt', content: 'must stay unchanged' },
          { workspacePath, permissionMode: 'full' },
        ),
      ).rejects.toThrow(/escapes workspace/)
      await expect(readFile(join(outside, 'existing.txt'), 'utf8')).resolves.toBe('protected')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('rejects writes through dangling directory links', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-write-jail-'))
    try {
      const workspacePath = join(dir, 'workspace')
      await mkdir(workspacePath)
      await symlink(join(dir, 'missing-outside'), join(workspacePath, 'dangling'), 'junction')

      await expect(
        findTool('write')!.execute(
          { path: 'dangling/new.txt', content: 'must not create' },
          { workspacePath, permissionMode: 'full' },
        ),
      ).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

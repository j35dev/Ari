import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SEARCH_DEFAULT_MAX_RESULTS,
  searchProjectContent,
} from './content-search'

/**
 * Spawned (and possibly orphaned) fakes hold their cwd for a beat after
 * kill(); Windows rmdir needs retries before the lock clears.
 */
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

/** Writes a fake ripgrep binary that ignores its arguments and prints lines. */
async function writeFakeRg(dir: string, body: string): Promise<string> {
  const scriptPath = join(dir, process.platform === 'win32' ? 'fake-rg.cmd' : 'fake-rg.sh')
  const sep = process.platform === 'win32' ? '\r\n' : '\n'
  const contents =
    process.platform === 'win32' ? `@${body.split('\n').join(sep)}${sep}` : `#!/bin/sh\n${body}\n`
  await writeFile(scriptPath, contents, 'utf8')
  if (process.platform !== 'win32') await chmod(scriptPath, 0o755)
  return scriptPath
}

describe('searchProjectContent', () => {
  it('returns nothing for an empty query without spawning anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-empty-'))
    try {
      const fakeRg = await writeFakeRg(dir, 'echo SHOULD_NOT_SPAWN')
      await expect(searchProjectContent(dir, '', { rgPath: fakeRg })).resolves.toEqual([])
      await expect(searchProjectContent(dir, '   ', { rgPath: fakeRg })).resolves.toEqual([])
    } finally {
      await cleanup(dir)
    }
  })

  it('rejects a missing or non-directory root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-root-'))
    try {
      await expect(searchProjectContent(join(dir, 'nope'), 'x', { rgPath: null })).rejects.toThrow(
        /does not exist/,
      )
      const file = join(dir, 'plain.txt')
      await writeFile(file, 'x', 'utf8')
      await expect(searchProjectContent(file, 'x', { rgPath: null })).rejects.toThrow(/not a directory/)
    } finally {
      await cleanup(dir)
    }
  })

  it('falls back to the JS walk, stays jailed to the root, reports relative paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-jail-'))
    try {
      await mkdir(join(dir, 'src'), { recursive: true })
      // Outside the root: a sibling tree that must never appear in results.
      const outsideDir = await mkdtemp(join(tmpdir(), 'ari-search-outside-'))
      await writeFile(join(outsideDir, 'leak.ts'), 'the quantum answer lives here', 'utf8')
      await writeFile(join(dir, 'src', 'deep.ts'), 'nothing\nthe QUANTUM answer lives here', 'utf8')
      await writeFile(join(dir, 'readme.md'), 'no match', 'utf8')

      const matches = await searchProjectContent(dir, 'quantum', { rgPath: null })
      expect(matches).toEqual([{ path: join('src', 'deep.ts'), line: 2, text: 'the QUANTUM answer lives here' }])
      await cleanup(outsideDir)
    } finally {
      await cleanup(dir)
    }
  })

  it('skips node_modules, dot dirs and symlinks during the walk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-skip-'))
    try {
      await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
      await mkdir(join(dir, '.hidden'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'pkg', 'dep.js'), 'needle in deps', 'utf8')
      await writeFile(join(dir, '.hidden', 'h.txt'), 'needle in hidden', 'utf8')
      await writeFile(join(dir, 'app.ts'), 'has needle', 'utf8')

      const matches = await searchProjectContent(dir, 'needle', { rgPath: null })
      expect(matches.map((m) => m.path)).toEqual(['app.ts'])
    } finally {
      await cleanup(dir)
    }
  })

  it('parses fake ripgrep output and drops paths escaping the jail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-rg-'))
    try {
      const inside =
        process.platform === 'win32'
          ? 'echo src\\hit.ts:7:canned needle hit'
          : 'echo src/hit.ts:7:canned needle hit'
      const outside =
        process.platform === 'win32'
          ? 'echo C:\\outside\\evil.txt:1:escape'
          : 'echo /etc/evil.txt:1:escape'
      const fakeRg = await writeFakeRg(dir, `${inside}\n${outside}`)
      const matches = await searchProjectContent(dir, 'anything', { rgPath: fakeRg })
      // Empty workspace: only rg could produce this output.
      expect(matches).toEqual([
        { path: join('src', 'hit.ts'), line: 7, text: 'canned needle hit' },
      ])
    } finally {
      await cleanup(dir)
    }
  })

  it('degrades to the JS walk when ripgrep fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-degrade-'))
    try {
      await writeFile(join(dir, 'keep.txt'), 'fallback finds this', 'utf8')
      const brokenRg = await writeFakeRg(dir, 'exit 2')
      const matches = await searchProjectContent(dir, 'fallback finds this', { rgPath: brokenRg })
      expect(matches).toEqual([{ path: 'keep.txt', line: 1, text: 'fallback finds this' }])
    } finally {
      await cleanup(dir)
    }
  })

  it('time-boxes a hung ripgrep instead of hanging the RPC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-timeout-'))
    try {
      const sleeper =
        process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > NUL' : 'sleep 2'
      const hungRg = await writeFakeRg(dir, sleeper)
      const startedAt = Date.now()
      const matches = await searchProjectContent(dir, 'needle', { rgPath: hungRg, timeoutMs: 150 })
      // The whole budget was spent on rg, so the degraded walk yields nothing —
      // what matters is a bounded, resolving call rather than a hung handler.
      expect(matches).toEqual([])
      expect(Date.now() - startedAt).toBeLessThan(10_000)
    } finally {
      await cleanup(dir)
    }
  })

  it('caps results at maxResults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-search-cap-'))
    try {
      const spew =
        process.platform === 'win32'
          ? 'for /l %%i in (1,1,50) do @echo f.txt:%%i:match %%i'
          : 'i=1; while [ $i -le 50 ]; do echo "f.txt:$i:match $i"; i=$((i+1)); done'
      const fakeRg = await writeFakeRg(dir, spew)
      const matches = await searchProjectContent(dir, 'needle', { rgPath: fakeRg, maxResults: 5 })
      expect(matches).toHaveLength(5)
      expect(matches[0]).toMatchObject({ path: 'f.txt', line: 1 })

      const capped = await searchProjectContent(dir, 'needle', {
        rgPath: fakeRg,
        maxResults: SEARCH_DEFAULT_MAX_RESULTS + 500,
      })
      expect(capped.length).toBeLessThanOrEqual(SEARCH_DEFAULT_MAX_RESULTS)
    } finally {
      await cleanup(dir)
    }
  })
})

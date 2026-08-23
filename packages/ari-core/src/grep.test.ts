import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTool } from './tools'
import { RG_MAX_MATCHES, searchWithRipgrep } from './rg'

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
  const contents = process.platform === 'win32' ? `@${body}\r\n` : `#!/bin/sh\n${body}\n`
  await writeFile(scriptPath, contents, 'utf8')
  if (process.platform !== 'win32') await chmod(scriptPath, 0o755)
  return scriptPath
}

describe('grep tool', () => {
  it('falls back to the JS walk when ripgrep is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-grep-js-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'the quantum leap\nnothing here', 'utf8')
      await writeFile(join(dir, 'b.md'), 'no match', 'utf8')
      const tool = findTool('grep')
      const result = await tool?.execute({ pattern: 'quantum' }, { workspacePath: dir, rgPath: null })
      expect(result).toBe(`a.txt:1:the quantum leap`)
    } finally {
      await cleanup(dir)
    }
  })

  it('uses the injected ripgrep binary when provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-grep-rg-'))
    try {
      // Empty workspace: only rg could produce this output.
      const fakeRg = await writeFakeRg(dir, 'echo rg-only.txt:7:canned ripgrep match')
      const tool = findTool('grep')
      const result = await tool?.execute(
        { pattern: 'needle' },
        { workspacePath: dir, rgPath: fakeRg },
      )
      expect(result).toContain('canned ripgrep match')
      expect(result).toContain('rg-only.txt:7:')
    } finally {
      await cleanup(dir)
    }
  })

  it('degrades to the JS walk when the injected ripgrep fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-grep-degrade-'))
    try {
      await writeFile(join(dir, 'keep.txt'), 'fallback finds this', 'utf8')
      const brokenRg = await writeFakeRg(dir, 'exit 2')
      const tool = findTool('grep')
      const result = await tool?.execute(
        { pattern: 'fallback finds this' },
        { workspacePath: dir, rgPath: brokenRg },
      )
      expect(result).toBe('keep.txt:1:fallback finds this')
    } finally {
      await cleanup(dir)
    }
  })
})

describe('searchWithRipgrep', () => {
  it('times out a hung binary and rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-grep-timeout-'))
    try {
      const sleeper =
        process.platform === 'win32'
          ? 'ping -n 2 127.0.0.1 > NUL'
          : 'sleep 2'
      const fakeRg = await writeFakeRg(dir, sleeper)
      await expect(
        searchWithRipgrep(fakeRg, 'needle', dir, { timeoutMs: 150 }),
      ).rejects.toThrow(/timed out/)
    } finally {
      await cleanup(dir)
    }
  })

  it('caps results at the match limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-grep-cap-'))
    try {
      const spew =
        process.platform === 'win32'
          ? 'for /l %%i in (1,1,150) do @echo f.txt:%%i:match'
          : 'i=1; while [ $i -le 150 ]; do echo "f.txt:$i:match"; i=$((i+1)); done'
      const fakeRg = await writeFakeRg(dir, spew)
      const result = await searchWithRipgrep(fakeRg, 'needle', dir)
      const lines = result.split('\n')
      expect(lines).toHaveLength(RG_MAX_MATCHES)
      expect(lines[0]).toContain('f.txt:1:')
    } finally {
      await cleanup(dir)
    }
  })

  it('reports no matches without treating exit 1 as failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-grep-none-'))
    try {
      // Real ripgrep exits 1 when nothing matches; emulate with a silent exit.
      const fakeRg = await writeFakeRg(dir, process.platform === 'win32' ? 'exit 1' : 'exit 1')
      const result = await searchWithRipgrep(fakeRg, 'needle', dir)
      expect(result).toBe('(no matches)')
    } finally {
      await cleanup(dir)
    }
  })
})

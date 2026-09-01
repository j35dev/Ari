import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './tools'
import { findTool } from './tools'

async function workspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ari-tools-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

/** Full-permission context: these tests exercise tool behavior, not gating. */
const READ_CTX = (dir: string): ToolContext => ({
  workspacePath: dir,
  permissionMode: 'full',
  rgPath: null,
})

describe('read tool', () => {
  it('reads a whole small file', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree', 'utf8')
      const result = await findTool('read')?.execute({ path: 'a.txt' }, READ_CTX(dir))
      expect(result).toBe('one\ntwo\nthree')
    } finally {
      await cleanup()
    }
  })

  it('paginates with 1-indexed offset and reports continuation', async () => {
    const { dir, cleanup } = await workspace()
    try {
      const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
      await writeFile(join(dir, 'big.txt'), content, 'utf8')
      const tool = findTool('read')
      const page = await tool?.execute({ path: 'big.txt', offset: 4, limit: 3 }, READ_CTX(dir))
      expect(page).toContain('line4')
      expect(page).toContain('line6')
      expect(page).not.toContain('line7')
      expect(page).toContain('[4 more lines in file. Use offset=7 to continue.]')
    } finally {
      await cleanup()
    }
  })

  it('caps oversized files with a truncated-at footer', async () => {
    const { dir, cleanup } = await workspace()
    try {
      const content = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join('\n')
      await writeFile(join(dir, 'huge.txt'), content, 'utf8')
      const result = await findTool('read')?.execute({ path: 'huge.txt' }, READ_CTX(dir))
      expect(result).toContain('[Showing lines 1-2000 of 2500 total. Use offset=2001 to continue.]')
      expect(result).not.toContain('l2500')
    } finally {
      await cleanup()
    }
  })

  it('accepts `file` as an alias for `path`', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf8')
      const result = await findTool('read')?.execute({ file: 'a.txt' }, READ_CTX(dir))
      expect(result).toBe('hello')
    } finally {
      await cleanup()
    }
  })

  it('rejects offsets beyond EOF and paths escaping the workspace', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'a.txt'), 'one\ntwo', 'utf8')
      const tool = findTool('read')
      await expect(tool?.execute({ path: 'a.txt', offset: 99 }, READ_CTX(dir))).rejects.toThrow(
        /beyond end of file/,
      )
      await expect(tool?.execute({ path: '../outside.txt' }, READ_CTX(dir))).rejects.toThrow(
        /escapes workspace/,
      )
    } finally {
      await cleanup()
    }
  })
})

describe('edit tool', () => {
  it('applies multiple unique edits and preserves CRLF + BOM', async () => {
    const { dir, cleanup } = await workspace()
    try {
      const path = 'crlf.txt'
      await writeFile(join(dir, path), '\uFEFFalpha beta\r\n gamma\r\n', 'utf8')
      const tool = findTool('edit')
      const result = await tool?.execute(
        {
          path,
          edits: [
            { oldText: 'alpha', newText: 'ALPHA' },
            { oldText: 'gamma', newText: 'GAMMA' },
          ],
        },
        READ_CTX(dir),
      )
      expect(result).toBe('Applied 2 edit(s) to crlf.txt')
      const { readFile } = await import('node:fs/promises')
      const after = await readFile(join(dir, path), 'utf8')
      expect(after.startsWith('\uFEFF')).toBe(true)
      expect(after).toContain('ALPHA beta\r\n GAMMA\r\n')
    } finally {
      await cleanup()
    }
  })

  it('rejects non-unique oldText and missing matches', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'dup.txt'), 'x\nx\n', 'utf8')
      const tool = findTool('edit')
      await expect(
        tool?.execute({ path: 'dup.txt', edits: [{ oldText: 'x', newText: 'y' }] }, READ_CTX(dir)),
      ).rejects.toThrow(/matches 2 times/)
      await expect(
        tool?.execute({ path: 'dup.txt', edits: [{ oldText: 'zzz', newText: 'y' }] }, READ_CTX(dir)),
      ).rejects.toThrow(/not found/)
    } finally {
      await cleanup()
    }
  })

  it('still accepts the single oldString/newString form', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 's.txt'), 'hello world', 'utf8')
      await findTool('edit')?.execute(
        { path: 's.txt', oldString: 'world', newString: 'there' },
        READ_CTX(dir),
      )
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(join(dir, 's.txt'), 'utf8')).toBe('hello there')
    } finally {
      await cleanup()
    }
  })
})

describe('glob and ls tools', () => {
  it('globs nested patterns and lists directories with trailing slashes', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await mkdir(join(dir, 'src', 'nested'), { recursive: true })
      await writeFile(join(dir, 'src', 'a.ts'), 'export {}', 'utf8')
      await writeFile(join(dir, 'src', 'nested', 'b.ts'), 'export {}', 'utf8')
      await writeFile(join(dir, 'readme.md'), '# hi', 'utf8')
      const globbed = await findTool('glob')?.execute({ pattern: 'src/**/*.ts' }, READ_CTX(dir))
      expect(globbed).toContain('src/a.ts')
      expect(globbed).toContain('src/nested/b.ts')
      expect(globbed).not.toContain('readme.md')
      const listed = await findTool('ls')?.execute({}, READ_CTX(dir))
      expect(listed).toContain('src/')
      expect(listed).toContain('readme.md')
    } finally {
      await cleanup()
    }
  })
})

describe('grep tool', () => {
  it('supports regex patterns and glob filters via the JS fallback', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'code.ts'), 'const ANSWER = 42\n', 'utf8')
      await writeFile(join(dir, 'notes.md'), 'const ANSWER = 42\n', 'utf8')
      const tool = findTool('grep')
      const regex = await tool?.execute(
        { pattern: 'ANSWER = \\d+', glob: '*.ts' },
        { workspacePath: dir, rgPath: null },
      )
      expect(regex).toContain('code.ts:1:')
      expect(regex).not.toContain('notes.md')
      const literal = await tool?.execute(
        { pattern: 'ANSWER = \\d+', literal: true },
        { workspacePath: dir, rgPath: null },
      )
      expect(literal).toBe('(no matches)')
    } finally {
      await cleanup()
    }
  })

  it('rejects invalid regex patterns with a precise error', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await expect(
        findTool('grep')?.execute({ pattern: '([unclosed' }, { workspacePath: dir, rgPath: null }),
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })
})

describe('bash tool', () => {
  it('reports non-zero exit codes instead of swallowing them', async () => {
    const { dir, cleanup } = await workspace()
    try {
      const failing = process.platform === 'win32' ? 'exit /b 3' : 'exit 3'
      const result = await findTool('bash')?.execute({ command: failing }, READ_CTX(dir))
      expect(result).toContain('[Command exited with code 3]')
    } finally {
      await cleanup()
    }
  })

  it('keeps the tail of oversized output', async () => {
    const { dir, cleanup } = await workspace()
    try {
      const spew =
        process.platform === 'win32'
          ? 'for /l %i in (1,1,3000) do @echo line%i'
          : 'i=1; while [ $i -le 3000 ]; do echo "line$i"; i=$((i+1)); done'
      const result = await findTool('bash')?.execute({ command: spew }, READ_CTX(dir))
      expect(result).toContain('line3000')
      expect(result).toContain('output truncated')
    } finally {
      await cleanup()
    }
  })
})

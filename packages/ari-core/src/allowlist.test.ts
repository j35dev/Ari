import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileGlob, matchesAllowlist, type AllowRule } from './allowlist'
import { findTool } from './tools'

describe('compileGlob', () => {
  it('matches exact strings', () => {
    expect(compileGlob('git status', 'git status')).toBe(true)
    expect(compileGlob('src/app.ts', 'src/app.ts')).toBe(true)
    expect(compileGlob('src/app.ts', 'src/main.ts')).toBe(false)
  })

  it('treats * as any run of characters within one path segment', () => {
    expect(compileGlob('npm *', 'npm run build')).toBe(true)
    expect(compileGlob('*.ts', 'app.ts')).toBe(true)
    expect(compileGlob('src/*.ts', 'src/app.ts')).toBe(true)
    // * does not cross path separators
    expect(compileGlob('src/*.ts', 'src/deep/app.ts')).toBe(false)
  })

  it('treats ** as crossing path separators', () => {
    expect(compileGlob('src/**', 'src/a/b/c.ts')).toBe(true)
    expect(compileGlob('**/*.ts', 'deep/nested/app.ts')).toBe(true)
    expect(compileGlob('**/*.ts', 'README.md')).toBe(false)
  })

  it('normalizes backslashes so patterns are platform-portable', () => {
    expect(compileGlob('src/**', 'src\\a\\b.ts')).toBe(true)
    expect(compileGlob('src\\**', 'src/a/b.ts')).toBe(true)
  })

  it('escapes regex metacharacters in the pattern literally', () => {
    expect(compileGlob('grep (x)', 'grep (x)')).toBe(true)
    expect(compileGlob('a+b.txt', 'aab.txt')).toBe(false)
    expect(compileGlob('a+b.txt', 'a+b.txt')).toBe(true)
  })
})

describe('matchesAllowlist candidate derivation', () => {
  const rules = (tool: string, ...patterns: string[]): AllowRule[] =>
    patterns.map((pattern) => ({ tool, pattern }))

  it('derives the command string for bash and matches exact/star patterns', () => {
    expect(matchesAllowlist('bash', '{"command":"git status"}', rules('bash', 'git status'))).toBe(
      true,
    )
    expect(matchesAllowlist('bash', '{"command":"git push origin main"}', rules('bash', 'git *'))).toBe(
      true,
    )
    expect(matchesAllowlist('bash', '{"command":"rm -rf /"}', rules('bash', 'git *'))).toBe(false)
  })

  it('derives the path for write / edit / read', () => {
    expect(
      matchesAllowlist('write', '{"path":"docs/readme.md"}', rules('write', 'docs/**')),
    ).toBe(true)
    expect(
      matchesAllowlist('edit', '{"path":"src/x.ts"}', rules('edit', '**/*.ts')),
    ).toBe(true)
    expect(
      matchesAllowlist('read', '{"path":"secrets.env"}', rules('read', '*.md')),
    ).toBe(false)
  })

  it('falls back to the tool name for other tools', () => {
    expect(matchesAllowlist('glob', '{}', rules('glob', 'glob'))).toBe(true)
    expect(matchesAllowlist('glob', '{}', rules('glob', 'grep'))).toBe(false)
  })

  it('ignores rules scoped to other tools', () => {
    expect(matchesAllowlist('bash', '{"command":"ls"}', rules('write', '*'))).toBe(false)
  })

  it('handles malformed JSON args safely without throwing', () => {
    expect(() => matchesAllowlist('bash', '{not json', rules('bash', 'git *'))).not.toThrow()
    expect(matchesAllowlist('bash', '{not json', rules('bash', 'git *'))).toBe(false)
    expect(matchesAllowlist('bash', '{not json', rules('bash', '*'))).toBe(true)
    expect(matchesAllowlist('bash', '', rules('bash', '*'))).toBe(true)
    // valid JSON that is not an object degrades to an empty candidate, same as malformed
    expect(matchesAllowlist('bash', '[1,2]', rules('bash', '*'))).toBe(true)
  })
})

describe('tool-level allowlist enforcement', () => {
  it('blocks a guarded tool when no rule matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-allow-'))
    try {
      const bash = findTool('bash')
      expect(bash).toBeDefined()
      await expect(
        bash?.execute({ command: 'echo hi' }, {
          workspacePath: dir,
          allowlist: [{ tool: 'bash', pattern: 'git *' }],
        }),
      ).rejects.toThrow('blocked by permission allowlist')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('allows a guarded tool when a rule matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-allow-'))
    try {
      const writer = findTool('write')
      expect(writer).toBeDefined()
      const result = await writer?.execute(
        { path: 'out/notes.md', content: 'hello' },
        {
          workspacePath: dir,
          permissionMode: 'full',
          allowlist: [{ tool: 'write', pattern: 'out/**' }],
        },
      )
      expect(result).toContain('Wrote')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('allows guarded tools under full mode with an empty or absent allowlist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-allow-'))
    try {
      const bash = findTool('bash')
      const editor = findTool('edit')
      await writeFile(join(dir, 'seed.txt'), 'alpha', 'utf8')
      await expect(
        bash?.execute(
          { command: 'echo unrestricted' },
          { workspacePath: dir, permissionMode: 'full', allowlist: [] },
        ),
      ).resolves.toContain('unrestricted')
      await expect(
        editor?.execute(
          { path: 'seed.txt', oldString: 'alpha', newString: 'beta' },
          { workspacePath: dir, permissionMode: 'full' },
        ),
      ).resolves.toContain('Applied 1 edit')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('no longer treats an empty allowlist as allow-all outside full mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-allow-'))
    try {
      const bash = findTool('bash')
      const writer = findTool('write')
      // Absent mode is ask (fail-closed): exec and writes are gated.
      await expect(
        bash?.execute({ command: 'echo gated' }, { workspacePath: dir, allowlist: [] }),
      ).rejects.toThrow("blocked by permission mode 'ask'")
      await expect(
        writer?.execute(
          { path: 'w.txt', content: 'x' },
          { workspacePath: dir, permissionMode: 'ask', allowlist: [] },
        ),
      ).rejects.toThrow("blocked by permission mode 'ask'")
      // Reads stay available in every mode.
      const reader = findTool('read')
      await writeFile(join(dir, 'open.txt'), 'visible', 'utf8')
      await expect(
        reader?.execute({ path: 'open.txt' }, { workspacePath: dir, permissionMode: 'ask' }),
      ).resolves.toBe('1\tvisible')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not gate unguarded tools even with rules present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-allow-'))
    try {
      const reader = findTool('read')
      await writeFile(join(dir, 'open.txt'), 'visible', 'utf8')
      await expect(
        reader?.execute({ path: 'open.txt' }, {
          workspacePath: dir,
          allowlist: [{ tool: 'read', pattern: 'never/**' }],
        }),
      ).resolves.toBe('1\tvisible')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enforces the allowlist through the agent loop context', async () => {
    const { runAgentLoop } = await import('./agent-loop')
    const blocked: string[] = []
    for await (const event of runAgentLoop({
      round: async function* () {
        yield {
          type: 'tool-started',
          callId: 'c1',
          name: 'bash',
          argsJson: JSON.stringify({ command: 'curl evil.example' }),
        }
        yield { type: 'done' }
      },
      systemPrompt: '',
      userPrompt: '',
      workspacePath: '.',
      permissionMode: 'full',
      allowlist: [{ tool: 'bash', pattern: 'git *' }],
    })) {
      if (event.type === 'tool-completed') blocked.push(event.resultJson)
    }
    expect(blocked[0]).toContain('blocked by permission allowlist')
  })
})

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DetectEnvironment } from '../types'
import { discoverExtensions, projectDirs, scanTomlMcp } from './inventory'

function env(home: string): DetectEnvironment {
  return {
    platform: 'win32',
    pathEnv: '',
    homeDir: home,
    vars: { CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') },
  }
}

describe('projectDirs', () => {
  it('stops at the git root and ignores a skill above it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-walk-'))
    try {
      const repo = join(root, 'repo')
      const nested = join(repo, 'pkg')
      await mkdir(join(nested, '.claude', 'skills', 'inside'), { recursive: true })
      await mkdir(join(root, '.claude', 'skills', 'outside'), { recursive: true })
      await mkdir(join(repo, '.git'))
      await writeFile(join(nested, '.claude', 'skills', 'inside', 'SKILL.md'), '---\nname: inside\n---\n')
      await writeFile(join(root, '.claude', 'skills', 'outside', 'SKILL.md'), '---\nname: outside\n---\n')
      expect(projectDirs(nested)).toEqual([nested, repo])
      const listed = await discoverExtensions({
        provider: 'claude',
        workspacePath: nested,
        env: env(join(root, 'home')),
      })
      expect(listed.records.filter((row) => row.kind === 'skill').map((row) => row.name)).toEqual(['inside'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not leave a directory that has no git root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-walk-nogit-'))
    try {
      const child = join(root, 'child')
      await mkdir(child, { recursive: true })
      expect(projectDirs(child)).toEqual([child])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('discoverExtensions', () => {
  it('lists Claude skills and MCP without copying secrets, and flags a bad file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-inv-'))
    try {
      const home = join(root, 'home')
      const project = join(root, 'proj')
      await mkdir(join(home, '.claude', 'skills', 'hello'), { recursive: true })
      await mkdir(join(project, '.git'), { recursive: true })
      await writeFile(
        join(home, '.claude', 'skills', 'hello', 'SKILL.md'),
        '---\nname: hello\ndescription: Says hello\n---\nbody\n',
      )
      await writeFile(
        join(project, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            filesystem: { command: 'npx', args: ['srv'], env: { TOKEN: 'secret' }, disabled: true },
            'ari-browser': { command: 'echo' },
          },
        }),
      )
      await writeFile(join(home, '.claude.json'), '{')
      await writeFile(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ plugins: { demo: true } }),
      )
      const listed = await discoverExtensions({
        provider: 'claude',
        workspacePath: project,
        env: env(home),
      })
      const skill = listed.records.find((row) => row.name === 'hello')
      expect(skill).toMatchObject({ kind: 'skill', scope: 'user', summary: 'Says hello', delivery: 'delegated' })
      const server = listed.records.find((row) => row.name === 'filesystem')
      expect(server).toMatchObject({
        kind: 'mcp',
        disabled: true,
        command: 'npx',
        transport: 'stdio',
      })
      expect(JSON.stringify(server)).not.toContain('secret')
      expect(JSON.stringify(server)).not.toContain('srv')
      expect(listed.records.find((row) => row.name === 'ari-browser')?.problem).toBe('duplicate-name')
      expect(listed.records.find((row) => row.name === '.claude.json')?.problem).toBe('unreadable')
      expect(listed.records.find((row) => row.name === 'demo')?.kind).toBe('plugin')
      expect(listed.records.filter((row) => row.name === 'filesystem')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps two Claude servers with the same name in different files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-inv-ids-'))
    try {
      const home = join(root, 'home')
      const repo = join(root, 'repo')
      const nested = join(repo, 'app')
      await mkdir(nested, { recursive: true })
      await mkdir(join(repo, '.git'))
      await mkdir(home, { recursive: true })
      await writeFile(
        join(nested, '.mcp.json'),
        JSON.stringify({ mcpServers: { filesystem: { command: 'one' } } }),
      )
      await writeFile(
        join(repo, '.mcp.json'),
        JSON.stringify({ mcpServers: { filesystem: { command: 'two' } } }),
      )
      const listed = await discoverExtensions({
        provider: 'claude',
        workspacePath: nested,
        env: env(home),
      })
      const rows = listed.records.filter((row) => row.name === 'filesystem')
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks an absolute missing command and ignores Codex inline tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-inv-codex-'))
    try {
      const home = join(root, 'home')
      const project = join(root, 'proj')
      await mkdir(join(home, '.codex'), { recursive: true })
      await mkdir(join(home, '.agents', 'skills', 'ship'), { recursive: true })
      await mkdir(join(project, '.git'), { recursive: true })
      await writeFile(join(home, '.agents', 'skills', 'ship', 'SKILL.md'), '---\nname: ship\n---\n')
      const missing = join(root, 'missing-bin')
      await writeFile(
        join(home, '.codex', 'config.toml'),
        [
          '[other]',
          'command = "nope"',
          '[mcp_servers.demo]',
          `command = "${missing}"`,
          'enabled = false',
          '[mcp_servers.demo.env]',
          'TOKEN = "secret"',
          'mcp_servers.inline = { command = "inline" }',
          '[[skills.config]]',
          `path = "${join(home, '.agents', 'skills', 'ship', 'SKILL.md')}"`,
          'enabled = false',
        ].join('\n'),
      )
      const listed = await discoverExtensions({
        provider: 'codex',
        workspacePath: project,
        env: env(home),
      })
      const demo = listed.records.find((row) => row.name === 'demo')
      expect(demo).toMatchObject({ disabled: true, problem: 'missing-binary', command: 'missing-bin' })
      expect(JSON.stringify(demo)).not.toContain('secret')
      expect(listed.records.some((row) => row.name === 'inline' || row.command === 'nope')).toBe(false)
      expect(listed.records.find((row) => row.name === 'ship')?.disabled).toBe(true)
      expect(scanTomlMcp('mcp_servers.demo = { command = "x" }\n', 'x', 'user')).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips a skill symlink that leaves the skill root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-inv-link-'))
    try {
      const home = join(root, 'home')
      const outside = join(root, 'outside')
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      await mkdir(join(outside, 'escaped'), { recursive: true })
      await writeFile(join(outside, 'escaped', 'SKILL.md'), '---\nname: escaped\n---\n')
      try {
        await symlink(join(outside, 'escaped'), join(home, '.claude', 'skills', 'escaped'), 'dir')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES') return
        throw error
      }
      const listed = await discoverExtensions({
        provider: 'claude',
        workspacePath: null,
        env: env(home),
      })
      expect(listed.records.some((row) => row.name === 'escaped')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sets truncated when a cap is hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-inv-cap-'))
    try {
      const home = join(root, 'home')
      await mkdir(join(home, '.claude', 'skills'), { recursive: true })
      for (let i = 0; i < 81; i++) {
        const dir = join(home, '.claude', 'skills', `s${i}`)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'SKILL.md'), `---\nname: s${i}\n---\n`)
      }
      const listed = await discoverExtensions({
        provider: 'claude',
        workspacePath: null,
        env: env(home),
      })
      expect(listed.truncated).toBe(true)
      expect(listed.records.filter((row) => row.kind === 'skill')).toHaveLength(80)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

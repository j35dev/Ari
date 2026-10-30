// @vitest-environment node
import { mkdir, realpath, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useTempDirs } from './testing/temp-dirs'
import { discoverAgentProjects } from './project-discovery'

const temp = useTempDirs()
async function folder(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return realpath(path)
}
async function record(path: string, value: unknown, tail = ''): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n${tail}`)
}

describe('agent project discovery', () => {
  it('merges existing Claude/Codex folders and orders recent metadata first', async () => {
    const home = temp('ari-discovery-')
    const older = await folder(home, 'older')
    const shared = await folder(home, 'shared')
    await record(join(home, '.claude.json'), {
      projects: { [older]: {}, [shared]: {} },
      token: 'must-not-cross-rpc',
    })
    await record(join(home, '.claude/projects/shared/one.jsonl'), { type: 'user', cwd: shared })
    await record(join(home, '.codex/sessions/2026/10/30/rollout-one.jsonl'), {
      type: 'session_meta',
      payload: { cwd: shared },
    })
    const result = await discoverAgentProjects({ homeDir: home })
    expect(result.projects).toHaveLength(2)
    expect(result.projects[0]).toMatchObject({
      path: shared,
      name: 'shared',
      sources: ['claude', 'codex'],
    })
    expect(result.projects[1]).toMatchObject({ path: older, lastUsedAt: null })
    expect(JSON.stringify(result)).not.toContain('must-not-cross-rpc')
    expect(result.truncated).toBe(false)
  })

  it('reads a prefix rather than large conversation/tool bodies', async () => {
    const home = temp('ari-discovery-')
    const path = await folder(home, 'workspace')
    await record(join(home, '.claude/projects/a/one.jsonl'), { cwd: path }, 'x'.repeat(1024 * 1024))
    const result = await discoverAgentProjects({ homeDir: home })
    expect(result.projects.map((p) => p.path)).toEqual([path])
    expect(result.truncated).toBe(false)
  })

  it('skips deleted/relative folders, linked worktrees and subagent rollouts', async () => {
    const home = temp('ari-discovery-')
    const linked = await folder(home, 'linked')
    await writeFile(join(linked, '.git'), 'gitdir: elsewhere')
    const child = await folder(home, 'child')
    const managed = await folder(home, '.worktrees/agent')
    const downloads = await folder(home, 'Downloads/repo')
    await record(join(home, '.claude.json'), {
      projects: {
        relative: {},
        [join(home, 'gone')]: {},
        [linked]: {},
        [managed]: {},
        [downloads]: {},
      },
    })
    await record(join(home, '.codex/sessions/2026/10/30/rollout-child.jsonl'), {
      type: 'session_meta',
      payload: { cwd: child, source: { subagent: 'parent' } },
    })
    expect((await discoverAgentProjects({ homeDir: home })).projects).toEqual([])
  })

  it('canonicalizes aliases so the same folder is not offered twice', async () => {
    const home = temp('ari-discovery-')
    const path = await folder(home, 'workspace')
    const alias = join(home, 'alias')
    await symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await record(join(home, '.claude.json'), { projects: { [path]: {}, [alias]: {} } })
    expect((await discoverAgentProjects({ homeDir: home })).projects).toHaveLength(1)
  })

  it('uses configured homes without reading the default account’s project list', async () => {
    const home = temp('ari-discovery-')
    const path = await folder(home, 'custom-project')
    const hidden = await folder(home, 'default-project')
    await record(join(home, '.claude.json'), { projects: { [hidden]: {} } })
    await record(join(home, 'custom-claude/projects/a/one.jsonl'), { cwd: path })
    const result = await discoverAgentProjects({
      homeDir: home,
      claudeHome: join(home, 'custom-claude'),
      codexHome: join(home, 'custom-codex'),
    })
    expect(result.projects.map((p) => p.path)).toEqual([path])
  })

  it('returns partial results at file/project budgets and warns about incomplete metadata', async () => {
    const home = temp('ari-discovery-')
    const path = await folder(home, 'workspace')
    await record(join(home, '.claude/projects/a/z.jsonl'), { cwd: path })
    await record(join(home, '.claude/projects/a/a.jsonl'), { cwd: path })
    const result = await discoverAgentProjects({ homeDir: home, maxFiles: 2 })
    expect(result.projects).toHaveLength(1)
    expect(result.truncated).toBe(true)
    const capped = await discoverAgentProjects({ homeDir: home, maxProjects: 1 })
    expect(capped.projects).toHaveLength(1)
    expect(capped.truncated).toBe(true)
    await writeFile(join(home, '.claude/projects/a/z.jsonl'), 'x'.repeat(64 * 1024))
    expect((await discoverAgentProjects({ homeDir: home })).truncated).toBe(true)
  })

  it('tolerates absent/malformed history and respects an already-aborted scan', async () => {
    const home = temp('ari-discovery-')
    await writeFile(join(home, '.claude.json'), '{broken')
    const result = await discoverAgentProjects({ homeDir: home })
    expect(result.projects).toEqual([])
    expect(result.warnings).toHaveLength(1)
    const controller = new AbortController()
    controller.abort()
    expect(await discoverAgentProjects({ homeDir: home, signal: controller.signal })).toEqual({
      projects: [],
      truncated: true,
      warnings: [],
    })
  })

  it('uses the newest timestamp when both agents know a project', async () => {
    const home = temp('ari-discovery-')
    const path = await folder(home, 'workspace')
    const claude = join(home, '.claude/projects/a/one.jsonl')
    const codex = join(home, '.codex/sessions/2026/10/30/rollout-one.jsonl')
    await record(claude, { cwd: path })
    await record(codex, { payload: { cwd: path } })
    await utimes(claude, 1000, 1000)
    await utimes(codex, 2000, 2000)
    expect((await discoverAgentProjects({ homeDir: home })).projects[0]?.lastUsedAt).toBe(2_000_000)
  })
})

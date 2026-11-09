// @vitest-environment node
import { mkdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HelmProject } from '@ari/contracts/agent-control'
import { ProjectContextCache, ProjectSelection, repositoryName } from './project-context'
import { useTempDirs } from './testing/temp-dirs'

const temp = useTempDirs()
function project(path: string): HelmProject {
  return { projectId: 'p', name: 'Project', path, available: true }
}
async function repo(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
  await writeFile(
    join(path, '.git/config'),
    '[remote "origin"]\nurl = git@github.com:owner/repo.git\n',
  )
}

describe('project routing context', () => {
  it('prefers a root package description and trims it to a single short line', async () => {
    const path = temp('ari-context-')
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({ description: `  Build\n${'x'.repeat(150)}` }),
    )
    await writeFile(join(path, 'README.md'), 'README fallback')
    const cache = new ProjectContextCache()
    await cache.refresh([project(path)])
    expect(cache.get('p').description).toBe(`Build ${'x'.repeat(94)}`)
    expect(cache.get('p').repository).toBeNull()
  })

  it.each(['{}', '{"description":"  "}', '{"description":42}', 'broken JSON'])(
    'falls back from %s to the first meaningful README line',
    async (manifest) => {
      const path = temp('ari-context-')
      await writeFile(join(path, 'package.json'), manifest)
      await writeFile(
        join(path, 'README.md'),
        '# Project\n\n[![Build](badge)](ci)\n<!--\nnoise\n-->\n```sh\ninstall\n```\n\nA [small](https://example.com) tool for teams.\nMore detail.',
      )
      const cache = new ProjectContextCache()
      await cache.refresh([project(path)])
      expect(cache.get('p').description).toBe('A small tool for teams.')
    },
  )

  it('supports a plain README and skips its setext title', async () => {
    const path = temp('ari-context-')
    await writeFile(join(path, 'README'), 'Project\n=======\n\nTools for gardeners.')
    const cache = new ProjectContextCache()
    await cache.refresh([project(path)])
    expect(cache.get('p').description).toBe('Tools for gardeners.')
  })

  it('reads the real local origin without exposing its URL in the context', async () => {
    const path = temp('ari-context-')
    await repo(path)
    await mkdir(join(path, '.git/objects'))
    await mkdir(join(path, '.git/refs'))
    await writeFile(join(path, '.git/HEAD'), 'ref: refs/heads/main\n')
    const cache = new ProjectContextCache()
    await cache.refresh([project(path)])
    expect(cache.get('p').repository).toBe('owner/repo')
    expect(JSON.stringify(cache.get('p'))).not.toContain('github.com')
  })

  it('reuses unchanged files and remote lookups, then refreshes changed sources', async () => {
    const path = temp('ari-context-')
    await repo(path)
    const manifest = join(path, 'package.json')
    const config = join(path, '.git/config')
    const time = new Date('2026-01-01T00:00:00Z')
    await writeFile(manifest, '{"description":"First"}')
    await utimes(manifest, time, time)
    const remote = vi.fn().mockResolvedValue('git@github.com:owner/first.git')
    const cache = new ProjectContextCache(remote)
    await cache.refresh([project(path)])
    await cache.refresh([project(path)])
    expect(remote).toHaveBeenCalledTimes(1)

    // A same-size edit with the same mtime proves the file contents are cached.
    await writeFile(manifest, '{"description":"Other"}')
    await utimes(manifest, time, time)
    await cache.refresh([project(path)])
    expect(cache.get('p').description).toBe('First')
    await utimes(manifest, time, new Date(time.getTime() + 10_000))
    await cache.refresh([project(path)])
    expect(cache.get('p').description).toBe('Other')
    expect(remote).toHaveBeenCalledTimes(1)

    remote.mockResolvedValue('https://github.com/owner/second.git')
    const configTime = (await stat(config)).mtimeMs
    await utimes(config, new Date(configTime + 10_000), new Date(configTime + 10_000))
    await cache.refresh([project(path)])
    expect(remote).toHaveBeenCalledTimes(2)
    expect(cache.get('p').repository).toBe('owner/second')

    await unlink(manifest)
    await writeFile(join(path, 'README.md'), 'New fallback.')
    await cache.refresh([project(path)])
    expect(cache.get('p').description).toBe('New fallback.')
    await unlink(config)
    await cache.refresh([project(path)])
    expect(cache.get('p').repository).toBeNull()
  })

  it('refreshes README edits, replaces changed project paths, and forgets removed projects', async () => {
    const path = temp('ari-context-')
    const readme = join(path, 'README.md')
    await writeFile(readme, 'Initial README.')
    const cache = new ProjectContextCache()
    await cache.refresh([project(path)])
    await writeFile(readme, 'A changed README description.')
    await cache.refresh([project(path)])
    expect(cache.get('p').description).toBe('A changed README description.')
    const other = temp('ari-context-')
    await writeFile(join(other, 'package.json'), '{"description":"Replacement folder"}')
    await cache.refresh([project(other)])
    expect(cache.get('p').description).toBe('Replacement folder')
    await cache.refresh([])
    expect(cache.get('p')).toEqual({ description: null, repository: null })
  })

  it('finds origin through a linked worktree and refreshes the common config', async () => {
    const path = temp('ari-context-')
    const common = join(path, 'common')
    const gitDir = join(common, 'worktrees/branch')
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(path, '.git'), `gitdir: ${gitDir}\n`)
    await writeFile(join(gitDir, 'commondir'), '../..\n')
    await writeFile(
      join(common, 'config'),
      '[remote "origin"]\nurl = ssh://git@host/team/app.git\n',
    )
    const remote = vi.fn().mockResolvedValue('ssh://git@host/team/app.git')
    const cache = new ProjectContextCache(remote)
    await cache.refresh([project(path)])
    expect(cache.get('p').repository).toBe('team/app')
    await cache.refresh([project(path)])
    expect(remote).toHaveBeenCalledTimes(1)
  })

  it('tolerates missing folders without git probes or losing other projects', async () => {
    const path = temp('ari-context-')
    await writeFile(join(path, 'README.md'), 'Available workspace.')
    const remote = vi.fn()
    const cache = new ProjectContextCache(remote)
    await cache.refresh([project(path), { projectId: 'gone', path: join(path, 'gone') }])
    expect(cache.get('gone')).toEqual({ description: null, repository: null })
    expect(cache.get('p').description).toBe('Available workspace.')
    expect(remote).not.toHaveBeenCalled()
  })

  it('bounds a stalled refresh while context reads and other folders remain available', async () => {
    const slow = temp('ari-context-')
    await repo(slow)
    const fast = temp('ari-context-')
    await writeFile(join(fast, 'README.md'), 'Fast workspace.')
    let finish: ((value: string | null) => void) | undefined
    const remote = vi.fn(
      () =>
        new Promise<string | null>((done) => {
          finish = done
        }),
    )
    const cache = new ProjectContextCache(remote)
    const refresh = cache.refresh([project(slow), { projectId: 'fast', path: fast }])
    expect(cache.get('p')).toEqual({ description: null, repository: null })
    await refresh
    expect(cache.get('fast').description).toBe('Fast workspace.')
    await cache.refresh([project(slow), { projectId: 'fast', path: fast }])
    expect(remote).toHaveBeenCalledTimes(1)
    finish?.('owner/repo')
  })
})

it.each([
  ['https://github.com/j35dev/Ari.git', 'j35dev/Ari'],
  ['https://user:secret@host/team/app.git/', 'team/app'],
  ['git@github.com:owner/repo.git', 'owner/repo'],
  ['ssh://git@host:2222/team/app.git', 'team/app'],
  ['git://host/team/app', 'team/app'],
  ['https://gitlab.com/group/subgroup/app.git', 'subgroup/app'],
  ['C:\\local\\repo', null],
  ['file:///local/repo', null],
  ['/local/repo', null],
  ['invalid', null],
  [null, null],
])('extracts only the repo identity from %s', (remote, expected) => {
  expect(repositoryName(remote)).toBe(expected)
})

it('tracks the focused project, ignores Aria and stale requests, and uses recent open as fallback', () => {
  const selection = new ProjectSelection()
  const projects: HelmProject[] = [
    { ...project('web'), projectId: 'web', lastOpenedAt: 10 },
    { ...project('api'), projectId: 'api', lastOpenedAt: 20 },
    { ...project('aria'), projectId: 'helm', lastOpenedAt: 100 },
  ]
  const last = (): string | undefined =>
    selection.withHistory(projects, []).find((p) => p.lastViewed)?.projectId
  expect(last()).toBe('api')
  selection.record('web', 30)
  selection.record('helm', 40)
  selection.record('api', 25)
  expect(last()).toBe('web')
  projects[1]!.lastOpenedAt = 50
  expect(last()).toBe('api')
  expect(selection.withHistory([], [])).toEqual([])
})

it('lists the three latest unarchived session titles per project, excluding Aria', () => {
  const selection = new ProjectSelection()
  const rows = [1, 4, 3, 2].map((n) => ({
    projectId: 'p',
    title: `Session ${n}`,
    updatedAt: n,
    archived: false,
  }))
  rows.push({ projectId: 'p', title: 'Archived', updatedAt: 10, archived: true })
  rows.push({ projectId: 'helm', title: 'Aria topic', updatedAt: 20, archived: false })
  const result = selection.withHistory(
    [project('p'), { ...project('aria'), projectId: 'helm' }],
    rows,
  )
  expect(result[0]?.recentSessionTitles).toEqual(['Session 4', 'Session 3', 'Session 2'])
  expect(result[1]?.recentSessionTitles).toEqual([])
})

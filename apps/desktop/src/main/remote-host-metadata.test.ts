// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import {
  HostResourceSampler,
  normalizeRepositoryRemote,
  readRepositoryIdentity,
  repositoryIdentityFromRemotes,
  RemoteWorkspaceSelections,
  type HostResourceSources,
} from './remote-host-metadata'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })
})
const cpu = (user: number, idle: number) => ({ times: { user, idle, nice: 0, sys: 0, irq: 0 } })
function counters() {
  let now = 1000
  let sample = 0
  const sources: HostResourceSources = {
    now: () => now,
    cpus: vi.fn(() => [cpu(++sample * 25, sample * 75)]),
    memory: vi.fn(async () => ({ available: 4 * 1024 ** 3, total: 8 * 1024 ** 3 })),
    pause: vi.fn(async () => undefined),
  }
  return {
    sources,
    advance: () => {
      now += 5001
    },
  }
}

describe('demand-only host counters', () => {
  it('starts without counters, shares concurrent measurement and uses byte units with a bounded cache', async () => {
    const h = counters()
    const sampler = new HostResourceSampler(h.sources)
    expect(h.sources.cpus).not.toHaveBeenCalled()
    const first = sampler.read()
    expect(sampler.read()).toBe(first)
    expect(await first).toMatchObject({
      status: 'available',
      cpuUtilization: 0.25,
      cpuCount: 1,
      availableMemoryBytes: 4 * 1024 ** 3,
      totalMemoryBytes: 8 * 1024 ** 3,
    })
    await sampler.read()
    expect(h.sources.cpus).toHaveBeenCalledTimes(2)
    h.advance()
    await sampler.read()
    expect(h.sources.cpus).toHaveBeenCalledTimes(4)
  })
  it.each(['reset', 'hotplug', 'invalid', 'memory'] as const)(
    'reports unavailable for %s without guessed utilization',
    async (failure) => {
      const h = counters()
      if (failure === 'reset')
        h.sources.cpus = vi
          .fn()
          .mockReturnValueOnce([cpu(100, 100)])
          .mockReturnValueOnce([cpu(1, 1)])
      if (failure === 'hotplug')
        h.sources.cpus = vi
          .fn()
          .mockReturnValueOnce([cpu(1, 1)])
          .mockReturnValueOnce([])
      if (failure === 'invalid') h.sources.cpus = vi.fn(() => [cpu(NaN, 1)])
      if (failure === 'memory') h.sources.memory = vi.fn(async () => ({ available: 9, total: 8 }))
      expect(await new HostResourceSampler(h.sources).read()).toMatchObject({
        status: 'unavailable',
        cpuUtilization: null,
        availableMemoryBytes: null,
        totalMemoryBytes: null,
        reason: 'Resource counters are unavailable.',
      })
    },
  )
})

describe('host repository and checkout identity', () => {
  it.each([
    'git@GitHub.com:Acme/App.git',
    'ssh://git@github.com/Acme/App.git/',
    'https://user:secret@github.com/Acme/App.git?token=secret#fragment',
  ])('correlates network spelling %s', (url) => {
    expect(normalizeRepositoryRemote(url)).toBe('github.com/acme/app')
  })
  it('selects deterministic network fetch remotes and never groups equal origin as a fork', () => {
    expect(
      repositoryIdentityFromRemotes([
        { name: 'upstream', url: '../local' },
        { name: 'zeta', url: 'git@forge.example:Team/Z.git' },
        { name: 'alpha', url: 'https://forge.example/Team/A.git' },
      ]),
    ).toMatchObject({ canonicalKey: 'forge.example/team/a', locator: { remoteName: 'alpha' } })
    expect(
      repositoryIdentityFromRemotes([
        { name: 'upstream', url: 'git@github.com:Acme/App.git' },
        { name: 'origin', url: 'https://github.com/Acme/App' },
      ]),
    ).not.toHaveProperty('origin')
  })
  it('reads common-root worktree configuration and rejects moved branch or cross-device checkout tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-host-repository-'))
    roots.push(root)
    const repo = join(root, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' }).toString().trim()
    git('init', '-q')
    git('config', 'user.email', 'fixture@example.test')
    git('config', 'user.name', 'Fixture')
    await writeFile(join(repo, 'readme'), 'first')
    git('add', '.')
    git('commit', '-qm', 'first')
    git('remote', 'add', 'origin', 'git@github.com:Fork/App.git')
    git('remote', 'add', 'upstream', 'https://github.com/Acme/App.git')
    const tree = join(root, 'tree')
    git('worktree', 'add', '-qb', 'feature', tree)
    expect(await readRepositoryIdentity(tree)).toEqual(await readRepositoryIdentity(repo))
    expect(await readRepositoryIdentity(join(root, 'missing'))).toBeNull()
    const project: Project = {
      id: 'p',
      name: 'Project',
      path: repo,
      status: 'ok',
      colorIndex: 0,
      createdAt: 1,
      lastOpenedAt: 0,
      open: true,
      defaultAgent: null,
    }
    const selections = new RemoteWorkspaceSelections()
    const options = await selections.list('device-a', project)
    const selected = options.options.find(
      (row) => row.kind === 'branch' && row.branch === 'feature',
    )!
    const commit = git('rev-parse', 'feature')
    expect(await selections.resolve('device-a', project, selected.token, 'isolated')).toEqual({
      baseSnapshotCommit: commit,
    })
    await expect(
      selections.resolve('device-b', project, selected.token, 'isolated'),
    ).rejects.toThrow('changed')
    await expect(selections.resolve('device-a', project, selected.token, 'shared')).rejects.toThrow(
      'changed',
    )
    await writeFile(join(repo, 'readme'), 'second')
    git('add', '.')
    git('commit', '-qm', 'second')
    git('update-ref', 'refs/heads/feature', 'HEAD')
    await expect(
      selections.resolve('device-a', project, selected.token, 'isolated'),
    ).rejects.toThrow('changed')
  })
})

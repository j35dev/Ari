import { randomUUID } from 'node:crypto'
import { cpus, freemem, totalmem } from 'node:os'
import { realpath } from 'node:fs/promises'
import { GitService, RepositoryGit } from '@ari/engine/git'
import type { Project } from '@ari/contracts/project'
import type { RemoteHostResources, RemoteProjectWorkspaces, RemoteRepositoryIdentity } from '@ari/contracts/remote'

/** Repository correlation only: never grants access or chooses an execution host. */
export function normalizeRepositoryRemote(raw: string): string | null {
  const value = raw.trim()
  if (!value || /[\u0000-\u0020\\]/.test(value) || /^(?:[a-z]:|file:|[./])/i.test(value)) return null
  let host: string
  let path: string
  try {
    if (value.includes('://')) {
      const url = new URL(value)
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
      host = url.hostname.toLowerCase()
      path = url.pathname
    } else {
      const match = /^(?:[^/@:]+@)?([^/:@]+):(.+)$/.exec(value)
      if (!match) return null
      host = match[1]!.toLowerCase()
      path = match[2]!.split(/[?#]/)[0]!
    }
  } catch { return null }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()
  if (!host || !path || /[\s:@?#\\]/.test(host + '/' + path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return null
  // Explicit Azure forge spelling; all other hostnames retain their literal identity.
  if (host === 'ssh.dev.azure.com' && /^v3\/[^/]+\/[^/]+\/[^/]+$/.test(path)) {
    const [, org, project, repo] = path.split('/')
    return `dev.azure.com/${org}/${project}/_git/${repo}`
  }
  return `${host}/${path}`
}

export function repositoryIdentityFromRemotes(remotes: readonly { name: string; url: string }[]): RemoteRepositoryIdentity | null {
  const valid = remotes.flatMap((remote) => {
    const key = normalizeRepositoryRemote(remote.url)
    return key ? [{ name: remote.name, key }] : []
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const selected = valid.find((row) => row.name === 'upstream') ?? valid.find((row) => row.name === 'origin') ?? valid[0]
  if (!selected) return null
  const origin = valid.find((row) => row.name === 'origin')
  return {
    canonicalKey: selected.key, displayName: selected.key.slice(selected.key.indexOf('/') + 1),
    locator: { source: 'git-remote', remoteName: selected.name },
    ...(origin && origin.key !== selected.key ? { origin: { canonicalKey: origin.key,
      displayName: origin.key.slice(origin.key.indexOf('/') + 1) } } : {}),
  }
}

export async function readRepositoryIdentity(path: string): Promise<RemoteRepositoryIdentity | null> {
  const configured = await new RepositoryGit(path).run(['config', '--null', '--get-regexp', '^remote\\..*\\.url$'],
    { allowExitOne: true, timeoutMs: 5000, maxBytes: 64 * 1024 })
  if (!configured.ok) return null
  const remotes = configured.value.split('\0').flatMap((record) => {
    const at = record.indexOf('\n')
    const name = /^remote\.(.+)\.url$/.exec(record.slice(0, at))?.[1]
    return at >= 0 && name ? [{ name, url: record.slice(at + 1) }] : []
  })
  return repositoryIdentityFromRemotes(remotes)
}

type CpuSample = { at: number; idle: number; total: number; count: number }
export class HostResourceSampler {
  #last: CpuSample | null = null
  #value: RemoteHostResources | null = null
  constructor(readonly now: () => number = Date.now) {}
  read(): RemoteHostResources {
    const at = this.now()
    if (this.#value && at - (this.#value.sampledAt ?? 0) < 1000) return this.#value
    const unavailable = (reason: string): RemoteHostResources => ({ status: 'unavailable', sampledAt: at,
      cpuUtilization: null, cpuCount: null, availableMemoryBytes: null, totalMemoryBytes: null, reason })
    try {
      const values = cpus()
      const sample = values.reduce((sum, cpu) => ({ ...sum, idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }),
        { at, idle: 0, total: 0, count: values.length })
      const previous = this.#last
      this.#last = sample
      const memory = totalmem()
      const available = freemem()
      if (!previous || at - previous.at < 250 || sample.count !== previous.count || sample.total <= previous.total || memory <= 0)
        return this.#value = unavailable('Waiting for a CPU sample.')
      const delta = sample.total - previous.total
      const idle = sample.idle - previous.idle
      if (idle < 0 || idle > delta || available < 0 || available > memory) return this.#value = unavailable('Resource counters are unavailable.')
      return this.#value = { status: 'available', sampledAt: at, cpuUtilization: 1 - idle / delta,
        cpuCount: sample.count, availableMemoryBytes: available, totalMemoryBytes: memory, reason: null }
    } catch { return this.#value = unavailable('Resource counters are unavailable.') }
  }
}

interface WorkspaceSelection { deviceId: string; projectId: string; root: string; expiresAt: number;
  mode: 'auto' | 'isolated' | 'shared'; ref: string | null; commit: string | null; base: boolean }
/** Opaque, host-issued selection tokens; never a filesystem or revision tunnel. */
export class RemoteWorkspaceSelections {
  readonly #tokens = new Map<string, WorkspaceSelection>()
  async list(deviceId: string, project: Project): Promise<RemoteProjectWorkspaces> {
    const root = await realpath(project.path)
    const git = new RepositoryGit(root)
    const branch = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 })
    const head = await git.run(['rev-parse', '--verify', 'HEAD'], { timeoutMs: 5000 })
    const commit = head.ok && /^[a-f0-9]{40,64}$/.test(head.value.trim()) ? head.value.trim() : null
    const currentBranch = branch.ok ? branch.value.trim() : null
    const options: RemoteProjectWorkspaces['options'] = []
    const mint = (label: string, kind: 'checkout' | 'branch' | 'worktree', mode: WorkspaceSelection['mode'],
      ref: string | null, oid: string | null, base: boolean, name: string | null) => {
      const token = randomUUID()
      const now = Date.now()
      for (const [key, value] of this.#tokens) if (value.expiresAt <= now) this.#tokens.delete(key)
      while (this.#tokens.size >= 512) this.#tokens.delete(this.#tokens.keys().next().value!)
      this.#tokens.set(token, { deviceId, projectId: project.id, root, expiresAt: now + 15 * 60_000,
        mode, ref, commit: oid, base })
      options.push({ token, label, kind, branch: name, workspaceMode: mode })
    }
    mint(currentBranch ?? 'Current checkout', 'checkout', 'auto', 'HEAD', commit, false, currentBranch)
    mint('Shared current checkout', 'checkout', 'shared', 'HEAD', commit, false, currentBranch)
    if (commit) mint('Isolated current checkout', 'checkout', 'isolated', 'HEAD', commit, true, currentBranch)
    let truncated = false
    if (commit) {
      const branches = await git.run(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(refname:short)', 'refs/heads/'],
        { timeoutMs: 5000, maxBytes: 64 * 1024 })
      if (branches.ok) for (const line of branches.value.trim().split('\n')) {
        const [ref, oid, name] = line.split('\t')
        if (!ref || !oid || !name || !/^[a-f0-9]{40,64}$/.test(oid)) continue
        if (options.length >= 190) { truncated = true; break }
        mint(name, 'branch', 'isolated', ref, oid, true, name)
      }
      const worktrees = await new GitService().listWorktrees(root)
      if (worktrees.ok) for (const tree of worktrees.value) {
        if (options.length >= 200) { truncated = true; break }
        if (tree.path === root) continue
        const oid = await new RepositoryGit(tree.path).run(['rev-parse', '--verify', 'HEAD'], { timeoutMs: 5000 })
        if (oid.ok && /^[a-f0-9]{40,64}$/.test(oid.value.trim()))
          mint(`Worktree: ${tree.branch || 'detached'}`, 'worktree', 'isolated', null, oid.value.trim(), true, tree.branch || null)
      }
    }
    return { projectId: project.id, options, truncated }
  }
  async resolve(deviceId: string, project: Project, token: string, mode: WorkspaceSelection['mode']): Promise<{ baseSnapshotCommit?: string }> {
    const selected = this.#tokens.get(token)
    const root = await realpath(project.path)
    if (!selected || selected.deviceId !== deviceId || selected.projectId !== project.id || selected.root !== root ||
      selected.expiresAt <= Date.now() || selected.mode !== mode) throw new Error('workspace selection expired or changed')
    if (selected.commit) {
      const resolved = await new RepositoryGit(root).run(['rev-parse', '--verify', '--end-of-options', selected.ref ?? selected.commit], { timeoutMs: 5000 })
      if (!resolved.ok || resolved.value.trim() !== selected.commit) throw new Error('workspace selection changed')
    }
    return selected.base && selected.commit ? { baseSnapshotCommit: selected.commit } : {}
  }
}

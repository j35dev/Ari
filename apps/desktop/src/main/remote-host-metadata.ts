import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem, type CpuInfo } from 'node:os'
import { open, realpath } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { GitService, RepositoryGit } from '@ari/engine/git'
import type { Project } from '@ari/contracts/project'
import type {
  RemoteHostResources,
  RemoteProjectWorkspaces,
  RemoteRepositoryIdentity,
} from '@ari/contracts/remote'

/** Repository correlation only: never grants access or chooses an execution host. */
export function normalizeRepositoryRemote(raw: string): string | null {
  const value = raw.trim()
  if (!value || /[\u0000-\u0020\\]/.test(value) || /^(?:[a-z]:|file:|[./])/i.test(value))
    return null
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
  } catch {
    return null
  }
  path = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
  if (
    !host ||
    !path ||
    /[\s:@?#\\]/.test(host + '/' + path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return null
  // Explicit Azure forge spelling; all other hostnames retain their literal identity.
  if (host === 'ssh.dev.azure.com' && /^v3\/[^/]+\/[^/]+\/[^/]+$/.test(path)) {
    const [, org, project, repo] = path.split('/')
    return `dev.azure.com/${org}/${project}/_git/${repo}`
  }
  return `${host}/${path}`
}

export function repositoryIdentityFromRemotes(
  remotes: readonly { name: string; url: string }[],
): RemoteRepositoryIdentity | null {
  const valid = remotes
    .flatMap((remote) => {
      const key = normalizeRepositoryRemote(remote.url)
      return key ? [{ name: remote.name, key }] : []
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const selected =
    valid.find((row) => row.name === 'upstream') ??
    valid.find((row) => row.name === 'origin') ??
    valid[0]
  if (!selected) return null
  const origin = valid.find((row) => row.name === 'origin')
  return {
    canonicalKey: selected.key,
    displayName: selected.key.slice(selected.key.indexOf('/') + 1),
    locator: { source: 'git-remote', remoteName: selected.name },
    ...(origin && origin.key !== selected.key
      ? {
          origin: {
            canonicalKey: origin.key,
            displayName: origin.key.slice(origin.key.indexOf('/') + 1),
          },
        }
      : {}),
  }
}

export async function readRepositoryIdentity(
  path: string,
): Promise<RemoteRepositoryIdentity | null> {
  const configured = await new RepositoryGit(path).run(
    ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'],
    { allowExitOne: true, timeoutMs: 5000, maxBytes: 64 * 1024 },
  )
  if (!configured.ok) return null
  const remotes = configured.value.split('\0').flatMap((record) => {
    const at = record.indexOf('\n')
    const name = /^remote\.(.+)\.url$/.exec(record.slice(0, at))?.[1]
    return at >= 0 && name ? [{ name, url: record.slice(at + 1) }] : []
  })
  return repositoryIdentityFromRemotes(remotes)
}

const run = promisify(execFile)
export interface HostResourceSources {
  now(): number
  cpus(): Pick<CpuInfo, 'times'>[]
  memory(): Promise<{ available: number; total: number }>
  pause(ms: number): Promise<unknown>
}

async function hostMemory(): Promise<{ available: number; total: number }> {
  const total = totalmem()
  if (process.platform === 'win32') return { available: freemem(), total }
  if (process.platform === 'linux') {
    const handle = await open('/proc/meminfo', 'r')
    try {
      const buffer = Buffer.alloc(16 * 1024 + 1)
      const { bytesRead } = await handle.read(buffer)
      if (bytesRead > 16 * 1024) throw new Error('memory report exceeds bound')
      const available = /^MemAvailable:\s+(\d+) kB$/m.exec(
        buffer.subarray(0, bytesRead).toString('utf8'),
      )
      if (!available) throw new Error('available memory is unknown')
      return { available: Number(available[1]) * 1024, total }
    } finally {
      await handle.close()
    }
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('/usr/bin/vm_stat', [], {
      timeout: 2000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    })
    const pageSize = /page size of (\d+) bytes/.exec(stdout)
    const pages = ['free', 'inactive', 'speculative'].map(
      (kind) => new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.$`, 'm').exec(stdout)?.[1],
    )
    if (!pageSize || pages.some((value) => value === undefined))
      throw new Error('available memory is unknown')
    return {
      available: pages.reduce((sum, value) => sum + Number(value), 0) * Number(pageSize[1]),
      total,
    }
  }
  throw new Error('available memory is unsupported')
}

/** Demand-only, one in-flight measurement shared by local/direct/managed reads. */
export class HostResourceSampler {
  #value: RemoteHostResources | null = null
  #pending: Promise<RemoteHostResources> | null = null
  constructor(
    readonly sources: HostResourceSources = { now: Date.now, cpus, memory: hostMemory, pause },
  ) {}
  read(): Promise<RemoteHostResources> {
    const age = this.sources.now() - (this.#value?.sampledAt ?? 0)
    if (this.#value && age >= 0 && age < 5000) return Promise.resolve(this.#value)
    if (this.#pending) return this.#pending
    this.#pending = this.#sample()
      .then((value) => {
        this.#value = value
        return value
      })
      .finally(() => {
        this.#pending = null
      })
    return this.#pending
  }
  async #sample(): Promise<RemoteHostResources> {
    const unavailable = (): RemoteHostResources => ({
      status: 'unavailable',
      sampledAt: this.sources.now(),
      cpuUtilization: null,
      cpuCount: null,
      availableMemoryBytes: null,
      totalMemoryBytes: null,
      reason,
    })
    const reason = 'Resource counters are unavailable.'
    try {
      const before = this.sources.cpus().map((cpu) => ({ ...cpu.times }))
      await this.sources.pause(250)
      const after = this.sources.cpus()
      if (!before.length || before.length > 4096 || after.length !== before.length)
        return unavailable()
      let totalDelta = 0
      let idleDelta = 0
      for (let index = 0; index < before.length; index++) {
        for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) {
          const previous = before[index]![key]
          const current = after[index]!.times[key]
          if (
            !Number.isFinite(current) ||
            !Number.isFinite(previous) ||
            previous < 0 ||
            current < previous
          )
            return unavailable()
          const delta = current - previous
          totalDelta += delta
          if (key === 'idle') idleDelta += delta
        }
      }
      const memory = await this.sources.memory()
      if (
        !Number.isFinite(totalDelta) ||
        totalDelta <= 0 ||
        !Number.isSafeInteger(memory.total) ||
        !Number.isSafeInteger(memory.available) ||
        memory.total <= 0 ||
        memory.available < 0 ||
        memory.available > memory.total
      )
        return unavailable()
      return {
        status: 'available',
        sampledAt: this.sources.now(),
        cpuUtilization: 1 - idleDelta / totalDelta,
        cpuCount: after.length,
        availableMemoryBytes: memory.available,
        totalMemoryBytes: memory.total,
        reason: null,
      }
    } catch {
      return unavailable()
    }
  }
}

interface WorkspaceSelection {
  deviceId: string
  projectId: string
  root: string
  expiresAt: number
  mode: 'auto' | 'isolated' | 'shared'
  ref: string | null
  commit: string | null
  base: boolean
}
/** Opaque, host-issued selection tokens; never a filesystem or revision tunnel. */
export class RemoteWorkspaceSelections {
  readonly #tokens = new Map<string, WorkspaceSelection>()
  async list(deviceId: string, project: Project): Promise<RemoteProjectWorkspaces> {
    const root = await realpath(project.path)
    const git = new RepositoryGit(root)
    const branch = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      timeoutMs: 5000,
    })
    const head = await git.run(['rev-parse', '--verify', 'HEAD'], { timeoutMs: 5000 })
    const commit = head.ok && /^[a-f0-9]{40,64}$/.test(head.value.trim()) ? head.value.trim() : null
    const currentBranch = branch.ok ? branch.value.trim() : null
    const options: RemoteProjectWorkspaces['options'] = []
    const mint = (
      label: string,
      kind: 'checkout' | 'branch' | 'worktree',
      mode: WorkspaceSelection['mode'],
      ref: string | null,
      oid: string | null,
      base: boolean,
      name: string | null,
    ) => {
      const token = randomUUID()
      const now = Date.now()
      for (const [key, value] of this.#tokens) if (value.expiresAt <= now) this.#tokens.delete(key)
      while (this.#tokens.size >= 512) this.#tokens.delete(this.#tokens.keys().next().value!)
      this.#tokens.set(token, {
        deviceId,
        projectId: project.id,
        root,
        expiresAt: now + 15 * 60_000,
        mode,
        ref,
        commit: oid,
        base,
      })
      options.push({ token, label, kind, branch: name, workspaceMode: mode })
    }
    mint(
      currentBranch ?? 'Current checkout',
      'checkout',
      'auto',
      'HEAD',
      commit,
      false,
      currentBranch,
    )
    mint('Shared current checkout', 'checkout', 'shared', 'HEAD', commit, false, currentBranch)
    if (commit)
      mint('Isolated current checkout', 'checkout', 'isolated', 'HEAD', commit, true, currentBranch)
    let truncated = false
    if (commit) {
      const branches = await git.run(
        ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(refname:short)', 'refs/heads/'],
        { timeoutMs: 5000, maxBytes: 64 * 1024 },
      )
      if (branches.ok)
        for (const line of branches.value.trim().split('\n')) {
          const [ref, oid, name] = line.split('\t')
          if (!ref || !oid || !name || !/^[a-f0-9]{40,64}$/.test(oid)) continue
          if (options.length >= 190) {
            truncated = true
            break
          }
          mint(name, 'branch', 'isolated', ref, oid, true, name)
        }
      const worktrees = await new GitService().listWorktrees(root)
      if (worktrees.ok)
        for (const tree of worktrees.value) {
          if (options.length >= 200) {
            truncated = true
            break
          }
          if (tree.path === root) continue
          const oid = await new RepositoryGit(tree.path).run(['rev-parse', '--verify', 'HEAD'], {
            timeoutMs: 5000,
          })
          if (oid.ok && /^[a-f0-9]{40,64}$/.test(oid.value.trim()))
            mint(
              `Worktree: ${tree.branch || 'detached'}`,
              'worktree',
              'isolated',
              null,
              oid.value.trim(),
              true,
              tree.branch || null,
            )
        }
    }
    return { projectId: project.id, options, truncated }
  }
  async resolve(
    deviceId: string,
    project: Project,
    token: string,
    mode: WorkspaceSelection['mode'],
  ): Promise<{ baseSnapshotCommit?: string }> {
    const selected = this.#tokens.get(token)
    const root = await realpath(project.path)
    if (
      !selected ||
      selected.deviceId !== deviceId ||
      selected.projectId !== project.id ||
      selected.root !== root ||
      selected.expiresAt <= Date.now() ||
      selected.mode !== mode
    )
      throw new Error('workspace selection expired or changed')
    if (selected.commit) {
      const resolved = await new RepositoryGit(root).run(
        ['rev-parse', '--verify', '--end-of-options', selected.ref ?? selected.commit],
        { timeoutMs: 5000 },
      )
      if (!resolved.ok || resolved.value.trim() !== selected.commit)
        throw new Error('workspace selection changed')
    }
    return selected.base && selected.commit ? { baseSnapshotCommit: selected.commit } : {}
  }
}

// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialReadModel } from '@ari/engine/projection'
import type { StreamFrame } from '@ari/contracts/rpc'
import { SourceControlHost } from './source-control-host'
import { RpcRegistry } from './rpc-registry'

let root: string
let hosts: SourceControlHost[]
const run = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
beforeEach(async () => {
  hosts = []
  root = await mkdtemp(join(tmpdir(), 'ari-scm-host-'))
  run('init', '-q')
  run('config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'a.txt'), 'before\n')
  run('add', '.')
  run(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@ari.dev',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'first',
  )
})
afterEach(async () => {
  for (const host of hosts) host.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
function fixture(options: Partial<ConstructorParameters<typeof SourceControlHost>[1]> = {}) {
  const frames: StreamFrame[] = []
  const registry = new RpcRegistry({ send: (frame) => frames.push(frame) })
  const host = new SourceControlHost(registry, {
    root: async (scope) => {
      if (scope.projectId === 'unknown') throw new Error('unknown project')
      return root
    },
    session: async () => initialReadModel(),
    ...options,
  })
  host.register()
  hosts.push(host)
  return { registry, host, frames }
}

describe('scoped source-control RPC', { timeout: 30_000 }, () => {
  it('registers all operations, validates paths/scopes and reports unavailable workspaces explicitly', async () => {
    const { registry } = fixture()
    for (const method of [
      'scm.summary',
      'scm.requests',
      'scm.status',
      'scm.review',
      'scm.diff',
      'scm.cancel',
    ] as const)
      expect(registry.hasHandler(method)).toBe(true)
    await expect(registry.invoke('scm.status', { projectId: 'p', sessionId: 's' })).rejects.toThrow(
      'invalid params',
    )
    await expect(
      registry.invoke('scm.diff', {
        projectId: 'p',
        snapshotId: 'a'.repeat(64),
        path: '../secret',
      }),
    ).rejects.toThrow('invalid params')
    expect(await registry.invoke('scm.status', { projectId: 'unknown' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
    expect(await registry.invoke('scm.status', { projectId: 'p' })).toMatchObject({
      ok: true,
      value: { commits: [{ subject: 'first' }] },
    })
    expect(await registry.invoke('scm.summary', { projectId: 'p' })).toMatchObject({
      ok: true,
      value: { changedFiles: 0 },
    })
    expect(await registry.invoke('scm.requests', { projectId: 'p' })).toMatchObject({
      ok: true,
      value: { repository: null, requests: [] },
    })
    run('remote', 'add', 'origin', 'https://github.com/acme/demo.git')
    const hostCommand = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          number: 4,
          title: 'Fix the bug',
          body: '',
          url: 'https://github.com/acme/demo/pull/4',
          state: 'OPEN',
          updatedAt: '2026-10-01T00:00:00Z',
          headRefOid: 'a'.repeat(40),
        },
      ]),
    }))
    const connected = fixture({ hostCommand })
    expect(await connected.registry.invoke('scm.requests', { projectId: 'p' })).toMatchObject({
      ok: true,
      value: { repository: { provider: 'github', name: 'acme/demo' }, requests: [{ number: 4 }] },
    })
    expect(hostCommand).toHaveBeenCalledWith('gh', expect.any(Array), root, expect.any(AbortSignal))
    await writeFile(join(root, 'dirty.txt'), 'pending\n')
    expect(await registry.invoke('scm.summary', { projectId: 'p' })).toMatchObject({
      ok: true,
      value: { changedFiles: 1 },
    })
    expect(
      await registry.invoke('scm.review', {
        projectId: 'p',
        comparison: { kind: 'turn', turnId: 'missing' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })

  it('routes stable turn/session endpoints and permits bounded file loading', async () => {
    const before = run('rev-parse', 'HEAD')
    run('update-ref', 'refs/ari-baselines/sess', before)
    await writeFile(join(root, 'a.txt'), 'after\n')
    run('add', '.')
    run(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@ari.dev',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'after',
    )
    const end = run('rev-parse', 'HEAD')
    const model = {
      ...initialReadModel(),
      sessionBaselineRef: 'refs/ari-baselines/sess',
      checkpoints: [{ turnId: 't', gitRef: before, endRef: end }],
    }
    const { registry } = fixture({ session: async () => model })
    const result = (await registry.invoke('scm.review', {
      sessionId: 's',
      comparison: { kind: 'turn', turnId: 't' },
    })) as { ok: true; value: { id: string; live: boolean } }
    expect(result.ok && result.value.live).toBe(false)
    const diff = (await registry.invoke('scm.diff', {
      sessionId: 's',
      snapshotId: result.value.id,
      path: 'a.txt',
    })) as { ok: boolean; value: string }
    expect(diff.ok).toBe(true)
    expect(diff.value).toContain('+after')
    expect(
      await registry.invoke('scm.review', { sessionId: 's', comparison: { kind: 'session' } }),
    ).toMatchObject({ ok: true })
  })

  it('cancels reads during scope resolution without leaving a pending request', async () => {
    let release!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    const { registry } = fixture({ root: () => pending })
    const result = registry.invoke('scm.status', { projectId: 'p', requestId: 'request' })
    expect(await registry.invoke('scm.cancel', { requestId: 'request' })).toEqual({
      cancelled: true,
    })
    release(root)
    expect(await result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await registry.invoke('scm.cancel', { requestId: 'request' })).toEqual({
      cancelled: false,
    })
  })
})

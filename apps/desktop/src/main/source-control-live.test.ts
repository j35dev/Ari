// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialReadModel } from '@ari/engine/projection'
import type { StreamFrame } from '@ari/contracts/rpc'
import { SourceControlHost } from './source-control-host'
import { SourceControlLive } from './source-control-live'
import { RpcRegistry } from './rpc-registry'

let root: string
const closers: (() => void)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-scm-live-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  await writeFile(join(root, 'a.txt'), 'new\n')
})
afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
function fixture(deps: ConstructorParameters<typeof SourceControlLive>[2]) {
  const frames: StreamFrame[] = []
  const registry = new RpcRegistry({ send: (frame) => frames.push(frame) })
  const host = new SourceControlHost(registry, {
    root: async () => root,
    session: async () => initialReadModel(),
  })
  const live = new SourceControlLive(registry, host, deps)
  host.register()
  live.register()
  closers.push(() => {
    live.close()
    host.close()
  })
  return { registry, live, frames }
}

describe('live source-control leases', { timeout: 30_000 }, () => {
  it('serializes shared common-directory mutations across instances and refuses live writers', async () => {
    let active = 0
    let peak = 0
    const busy = async (): Promise<boolean> => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active--
      return true
    }
    const a = fixture({ busy })
    const b = fixture({ busy })
    const snapshots = (await Promise.all(
      [a, b].map(({ registry }) =>
        registry.invoke('scm.review', { projectId: 'p', comparison: { kind: 'working-tree' } }),
      ),
    )) as { value: { id: string } }[]
    const results = await Promise.all(
      [a, b].map(({ registry }, index) =>
        registry.invoke('scm.mutate', {
          projectId: 'p',
          action: { kind: 'stage', paths: ['a.txt'], snapshotId: snapshots[index]!.value.id },
        }),
      ),
    )
    expect(peak).toBe(1)
    for (const result of results)
      expect(result).toMatchObject({ ok: false, error: { code: 'busy' } })
    const c = fixture({ busy: async () => false })
    const snapshot = (await c.registry.invoke('scm.review', {
      projectId: 'p',
      comparison: { kind: 'working-tree' },
    })) as { value: { id: string } }
    expect(
      await c.registry.invoke('scm.mutate', {
        projectId: 'p',
        action: { kind: 'stage', paths: ['a.txt'], snapshotId: snapshot.value.id },
      }),
    ).toMatchObject({ ok: true })
  })

  it('shares one watcher and releases startup that completes after unsubscribe', async () => {
    const close = vi.fn(async () => undefined)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let notify!: (error?: string) => void
    const watch = vi.fn(async (_root: string, onChange: typeof notify) => {
      notify = onChange
      await pending
      return { ok: true as const, value: close }
    })
    const { registry, live, frames } = fixture({ watch, busy: async () => false })
    for (const id of ['a', 'b']) {
      registry.subscribe({ id, name: 'scm.changed', params: { projectId: 'p' } })
      live.watch(id, { projectId: 'p' })
    }
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1))
    notify('live error')
    expect(frames.map((frame) => frame.id).sort()).toEqual(['a', 'b'])
    expect(frames[0]?.payload).toMatchObject({ error: 'live error', revision: 1 })
    for (const id of ['a', 'b']) {
      live.unwatch(id)
      registry.unsubscribe(id)
    }
    release()
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })

  it('does not start abandoned scopes and surfaces failed watcher startup', async () => {
    const watch = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'unavailable' as const, message: 'cannot watch' },
    }))
    const { registry, live, frames } = fixture({ watch, busy: async () => false })
    registry.subscribe({ id: 'a', name: 'scm.changed', params: { projectId: 'p' } })
    live.watch('a', { projectId: 'p' })
    live.unwatch('a')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(watch).not.toHaveBeenCalled()
    live.watch('a', { projectId: 'p' })
    await vi.waitFor(() => expect(frames[0]?.payload).toMatchObject({ error: 'cannot watch' }))
  })
})

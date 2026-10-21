import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeRoots } from './worktree-roots'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-worktree-roots-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WorktreeRoots', () => {
  it('walks sessions once while the session set is unchanged', async () => {
    const wt = join(dir, 'wt-a')
    await mkdir(wt)
    const collect = vi.fn(async () => [wt])
    const roots = new WorktreeRoots({ sessionDirs: async () => ['b', 'a'], collect })

    expect(await roots.get()).toEqual([wt])
    expect(await roots.get()).toEqual([wt])
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('re-walks when a session directory appears or disappears', async () => {
    let dirs = ['a']
    const collect = vi.fn(async () => [])
    const roots = new WorktreeRoots({ sessionDirs: async () => dirs, collect })

    await roots.get()
    dirs = ['a', 'b']
    await roots.get()
    dirs = ['b']
    await roots.get()
    expect(collect).toHaveBeenCalledTimes(3)
  })

  it('re-walks after invalidate', async () => {
    const collect = vi.fn(async () => [])
    const roots = new WorktreeRoots({ sessionDirs: async () => ['a'], collect })

    await roots.get()
    roots.invalidate()
    await roots.get()
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('drops cached roots whose worktree no longer exists', async () => {
    const wt = join(dir, 'wt-gone')
    await mkdir(wt)
    const roots = new WorktreeRoots({ sessionDirs: async () => ['a'], collect: async () => [wt] })

    expect(await roots.get()).toEqual([wt])
    await rm(wt, { recursive: true })
    expect(await roots.get()).toEqual([])
  })

  it('retries the walk after a failure instead of caching it', async () => {
    const collect = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([])
    const roots = new WorktreeRoots({ sessionDirs: async () => ['a'], collect })

    await expect(roots.get()).rejects.toThrow('boom')
    expect(await roots.get()).toEqual([])
    expect(collect).toHaveBeenCalledTimes(2)
  })
})

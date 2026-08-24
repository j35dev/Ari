import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeAllWatchers,
  ensureProjectWatched,
  getIndexedFiles,
  getWatcher,
  stopWatchingProject,
} from './watcher-bridge'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-watcher-bridge-'))
})

afterEach(async () => {
  await closeAllWatchers()
  await rm(dir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

describe('watcher bridge', () => {
  it('lazily creates and reuses one watcher per project path', () => {
    const first = getWatcher(dir)
    const second = getWatcher(dir)
    expect(second).toBe(first)
    expect(first.rootCount).toBe(1)
  })

  it('maps distinct project paths to distinct watchers', async () => {
    const other = join(dir, 'other')
    await mkdir(other, { recursive: true })
    const a = getWatcher(dir)
    const b = getWatcher(other)
    expect(b).not.toBe(a)
  })

  it('closes every watcher on closeAllWatchers', async () => {
    const watcher = getWatcher(dir)
    await closeAllWatchers()
    expect(watcher.rootCount).toBe(0)
    expect(getWatcher(dir)).not.toBe(watcher)
  })

  it('stops one project without touching the others', async () => {
    const other = join(dir, 'other')
    await mkdir(other, { recursive: true })
    const stopped = getWatcher(dir)
    const kept = getWatcher(other)

    await stopWatchingProject(dir, 'p1')
    expect(stopped.rootCount).toBe(0)
    // The next watch request starts fresh instead of reusing the closed one.
    expect(getWatcher(dir)).not.toBe(stopped)
    expect(kept.rootCount).toBe(1)
    expect(getWatcher(other)).toBe(kept)
  })

  it('drops the file index of a removed project', async () => {
    await ensureProjectWatched({ id: 'p2', path: dir }, { debounceMs: 25 })
    expect(getIndexedFiles('p2')).not.toBeNull()

    await stopWatchingProject(dir, 'p2')
    expect(getIndexedFiles('p2')).toBeNull()
  })

  it('is a no-op for a path that was never watched', async () => {
    await expect(stopWatchingProject(join(dir, 'never-watched'), 'nope')).resolves.toBeUndefined()
  })

  it('builds the file index for a project and is idempotent per id', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), '')
    await writeFile(join(dir, 'b.md'), '')

    await ensureProjectWatched({ id: 'p1', path: dir }, { debounceMs: 25 })
    await ensureProjectWatched({ id: 'p1', path: dir }, { debounceMs: 25 })
    expect(getIndexedFiles('p1')).toEqual(['b.md', 'src/a.ts'])
  })

  it('applies watcher change batches to the project index', async () => {
    await ensureProjectWatched({ id: 'p2', path: dir }, { debounceMs: 25 })
    await sleep(150)

    const added = join(dir, 'later.ts')
    await writeFile(added, '')
    await vi.waitFor(() => expect(getIndexedFiles('p2')).toContain('later.ts'), {
      timeout: 3000,
    })

    await rm(added)
    await vi.waitFor(() => expect(getIndexedFiles('p2')).not.toContain('later.ts'), {
      timeout: 3000,
    })
  })

  it('clears indexes on closeAllWatchers', async () => {
    await ensureProjectWatched({ id: 'p3', path: dir }, { debounceMs: 25 })
    expect(getIndexedFiles('p3')).not.toBeNull()
    await closeAllWatchers()
    expect(getIndexedFiles('p3')).toBeNull()
  })
})

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeAllWatchers, getWatcher } from './watcher-bridge'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-watcher-bridge-'))
})

afterEach(async () => {
  await closeAllWatchers()
  await rm(dir, { recursive: true, force: true })
})

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
})

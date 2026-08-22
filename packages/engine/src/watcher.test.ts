import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceWatcher } from './watcher'

const SETTLE_MS = 120

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Collects onChange batches; `next` fails if no batch lands within 1s. */
class BatchCollector {
  readonly batches: string[][] = []
  #notify: (() => void) | null = null

  push(paths: string[]): void {
    this.batches.push(paths)
    const notify = this.#notify
    this.#notify = null
    notify?.()
  }

  next(timeoutMs = 1000): Promise<string[]> {
    if (this.#notify !== null) throw new Error('already waiting for a batch')
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#notify = null
        rejectPromise(new Error(`no change batch within ${timeoutMs}ms`))
      }, timeoutMs)
      this.#notify = () => {
        clearTimeout(timer)
        resolvePromise(this.batches[this.batches.length - 1] ?? [])
      }
    })
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-watcher-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WorkspaceWatcher', () => {
  it('delivers a created file as a change batch within 1s', async () => {
    const collector = new BatchCollector()
    const watcher = new WorkspaceWatcher({ events: { onChange: (p) => collector.push(p) } })
    try {
      watcher.watch(dir)
      await sleep(SETTLE_MS)
      const pending = collector.next()
      await writeFile(join(dir, 'hello.txt'), 'hi')
      expect(await pending).toEqual([join(dir, 'hello.txt')])
    } finally {
      await watcher.close()
    }
  })

  it('batches rapid writes into a single sorted callback', async () => {
    const collector = new BatchCollector()
    const watcher = new WorkspaceWatcher({ events: { onChange: (p) => collector.push(p) } })
    try {
      watcher.watch(dir)
      await sleep(SETTLE_MS)
      const pending = collector.next()
      await Promise.all([
        writeFile(join(dir, 'c.txt'), '1'),
        writeFile(join(dir, 'a.txt'), '2'),
        writeFile(join(dir, 'b.txt'), '3'),
      ])
      const batch = await pending
      expect(batch).toEqual([
        join(dir, 'a.txt'),
        join(dir, 'b.txt'),
        join(dir, 'c.txt'),
      ])
      expect(collector.batches).toHaveLength(1)
    } finally {
      await watcher.close()
    }
  })

  it('ignores default noise dirs and root dotfiles, honors extra ignored names', async () => {
    const collector = new BatchCollector()
    const watcher = new WorkspaceWatcher({ events: { onChange: (p) => collector.push(p) } })
    try {
      watcher.watch(dir, { ignored: ['scratch'] })
      await sleep(SETTLE_MS)
      await mkdir(join(dir, 'node_modules'), { recursive: true })
      await mkdir(join(dir, '.git'), { recursive: true })
      await mkdir(join(dir, 'scratch'), { recursive: true })
      await mkdir(join(dir, 'nested', 'dot.dir'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'pkg.js'), '{}')
      await writeFile(join(dir, '.git', 'index'), '')
      await writeFile(join(dir, '.env'), 'SECRET')
      await writeFile(join(dir, 'scratch', 'x.txt'), 'x')
      await sleep(600)
      expect(collector.batches).toHaveLength(0)
      // Nested dotfiles are past depth 1 and stay watchable.
      await writeFile(join(dir, 'nested', 'dot.dir', 'deep.txt'), 'd')
      expect(await collector.next()).toEqual([join(dir, 'nested', 'dot.dir', 'deep.txt')])
    } finally {
      await watcher.close()
    }
  })

  it('close discards pending events and stops delivery', async () => {
    const collector = new BatchCollector()
    const watcher = new WorkspaceWatcher({ events: { onChange: (p) => collector.push(p) } })
    watcher.watch(dir)
    await sleep(SETTLE_MS)
    await writeFile(join(dir, 'pending.txt'), 'x')
    await watcher.close()
    await writeFile(join(dir, 'after-close.txt'), 'y')
    await sleep(600)
    expect(collector.batches).toHaveLength(0)
    await expect(watcher.close()).resolves.toBeUndefined()
    expect(() => watcher.watch(dir)).toThrow(/closed/)
  })

  it('counts distinct watched roots and ignores duplicates', async () => {
    const collector = new BatchCollector()
    const watcher = new WorkspaceWatcher({ events: { onChange: (p) => collector.push(p) } })
    try {
      const other = join(dir, 'other')
      await mkdir(other, { recursive: true })
      expect(watcher.rootCount).toBe(0)
      watcher.watch(dir)
      watcher.watch(other)
      watcher.watch(resolve(dir))
      if (process.platform === 'win32') watcher.watch(resolve(dir).toUpperCase())
      expect(watcher.rootCount).toBe(2)
      await watcher.close()
      expect(watcher.rootCount).toBe(0)
    } finally {
      await watcher.close()
    }
  })
})

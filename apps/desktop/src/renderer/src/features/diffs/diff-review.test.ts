// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDiff } from './parseDiff'
import { reviewRows } from './review-rows'
import { DiffHighlightPool, type HighlightReply } from './diff-highlight-pool'

const diff =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n same\n-old\n+new\n+added\n tail'

describe('review row alignment', () => {
  it('aligns uneven replacements without losing either line number', () => {
    const rows = reviewRows(parseDiff(diff).files[0]!, true, false)
    expect(rows[2]?.old).toMatchObject({ content: 'old', oldLineNo: 2 })
    expect(rows[2]?.next).toMatchObject({ content: 'new', newLineNo: 2 })
    expect(rows[3]?.old).toBeUndefined()
    expect(rows[3]?.next?.newLineNo).toBe(3)
    expect(rows[4]?.old?.oldLineNo).toBe(3)
    expect(rows[4]?.next?.newLineNo).toBe(4)
  })
  it('preserves separate deletion/addition rows in unified layout', () => {
    const rows = reviewRows(parseDiff(diff).files[0]!, false, false)
    expect(rows[2]?.old?.content).toBe('old')
    expect(rows[2]?.next).toBeUndefined()
    expect(rows[3]?.next?.content).toBe('new')
  })
  it('filters only wholly whitespace-equivalent replacement runs', () => {
    const file = parseDiff(diff.replace('-old\n+new\n+added', '-const x = 1\n+const x=1\n+added'))
      .files[0]!
    expect(reviewRows(file, true, true)).toHaveLength(5)
    const equivalent = parseDiff('--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const x = 1\n+const x=1')
      .files[0]!
    expect(reviewRows(equivalent, true, true)).toEqual([{ header: '@@ -1 +1 @@' }])
  })
})

class FakeWorker {
  onmessage: ((event: MessageEvent<HighlightReply>) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
}
const pools: DiffHighlightPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
  vi.useRealTimers()
})
function fixture() {
  const worker = new FakeWorker()
  const create = vi.fn(() => worker as unknown as Worker)
  const pool = new DiffHighlightPool(create, 1000)
  pools.push(pool)
  return { worker, pool, create }
}

describe('diff worker lifecycle', () => {
  it('shares the worker and routes out-of-order replies by request identity', async () => {
    vi.useFakeTimers()
    const { worker, pool, create } = fixture()
    const a = pool.request('typescript', [])
    const b = pool.request('python', [])
    worker.onmessage?.(
      new MessageEvent<HighlightReply>('message', { data: { id: 2, html: { line: 'second' } } }),
    )
    worker.onmessage?.(
      new MessageEvent<HighlightReply>('message', { data: { id: 1, html: { line: 'first' } } }),
    )
    expect(await a.promise).toEqual({ line: 'first' })
    expect(await b.promise).toEqual({ line: 'second' })
    expect(create).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1000)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('bounds pending requests and resolves cancellation/failure as plain text', async () => {
    const { worker, pool } = fixture()
    const requests = Array.from({ length: 10 }, () => pool.request('typescript', []))
    expect(await requests[0]!.promise).toEqual({})
    requests[9]!.cancel()
    expect(await requests[9]!.promise).toEqual({})
    worker.onerror?.()
    expect(await requests[8]!.promise).toEqual({})
    expect(worker.terminate).toHaveBeenCalled()
  })
})

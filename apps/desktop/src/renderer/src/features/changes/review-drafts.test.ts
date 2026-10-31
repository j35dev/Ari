import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendReviewNote,
  dropReviewDraftMemory,
  formatReviewDrafts,
  readReviewDrafts,
  rememberReviewRange,
  reviewDraftChipLabel,
  subscribeReviewDrafts,
  writeReviewDrafts,
  type ReviewDraft,
} from './review-drafts'

const sessionId = 'sess_1'
const comparisonId = 'a'.repeat(64)

afterEach(() => {
  sessionStorage.clear()
  dropReviewDraftMemory()
})

describe('review drafts', () => {
  it('restores a line note after the memory cache is dropped', () => {
    appendReviewNote(sessionId, { path: 'src/a.ts', line: 4, text: 'extract a helper' })
    expect(formatReviewDrafts(readReviewDrafts(sessionId))).toBe(
      'Review notes on your changes:\n- src/a.ts:4 — extract a helper',
    )
    dropReviewDraftMemory()
    const restored = readReviewDrafts(sessionId)
    expect(restored).toMatchObject([{ path: 'src/a.ts', line: 4, text: 'extract a helper' }])
    expect(reviewDraftChipLabel(restored[0]!)).toBe('a.ts:4')
  })

  it('replaces a range on the same file and side and keeps the other side', () => {
    const listener = vi.fn()
    const stop = subscribeReviewDrafts(listener)
    const range = {
      path: 'src/a.ts',
      comparisonId,
      side: 'new' as const,
      startLine: 3,
      endLine: 3,
      context: 'const value = 1',
    }
    rememberReviewRange(sessionId, range)
    rememberReviewRange(sessionId, {
      ...range,
      endLine: 5,
      context: 'const value = 1\nconst next = 2',
    })
    rememberReviewRange(sessionId, { ...range, side: 'old', endLine: 4, context: 'old line' })
    const drafts = readReviewDrafts(sessionId)
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({ side: 'new', startLine: 3, endLine: 5, line: 3 })
    expect(drafts[1]).toMatchObject({ side: 'old', startLine: 3, endLine: 4, line: null })
    expect(reviewDraftChipLabel(drafts[0]!)).toBe('a.ts:3-5')
    expect(formatReviewDrafts(drafts)).toContain('src/a.ts:3-5 (new) — Selected new lines 3-5')
    expect(formatReviewDrafts(drafts)).toContain('  const next = 2')
    expect(listener).toHaveBeenCalledTimes(3)
    dropReviewDraftMemory()
    expect(readReviewDrafts(sessionId)).toHaveLength(2)
    stop()
  })

  it('drops malformed entries and clears storage when the last note is removed', () => {
    sessionStorage.setItem(
      `ari:review-drafts:${sessionId}`,
      JSON.stringify([
        { path: '../secret', text: 'no' },
        { path: 'src/a.ts', line: 0, text: 'no' },
        { path: 'src/a.ts', line: 2, text: '   ' },
        { path: 'src/a.ts', line: 2, text: 'keep' },
        { path: 'src/a.ts', line: null, text: 'also', comparisonId: 'not-an-oid' },
      ]),
    )
    expect(readReviewDrafts(sessionId)).toEqual([
      expect.objectContaining({ path: 'src/a.ts', line: 2, text: 'keep' }),
    ])
    writeReviewDrafts(sessionId, [])
    expect(sessionStorage.getItem(`ari:review-drafts:${sessionId}`)).toBeNull()
    expect(readReviewDrafts(sessionId)).toEqual([])
  })

  it('ignores a broken payload and an invalid range', () => {
    sessionStorage.setItem(`ari:review-drafts:${sessionId}`, '{')
    expect(readReviewDrafts(sessionId)).toEqual([])
    rememberReviewRange(sessionId, {
      path: 'src/a.ts',
      comparisonId: 'nope',
      side: 'new',
      startLine: 4,
      endLine: 2,
      context: 'backwards',
    })
    appendReviewNote(sessionId, { path: 'src/a.ts', line: 1, text: '   ' })
    expect(readReviewDrafts(sessionId)).toEqual([])
  })

  it('keeps a draft identity when the stored id is missing', () => {
    const stored: Omit<ReviewDraft, 'id'> = { path: 'src/a.ts', line: null, text: 'note' }
    sessionStorage.setItem(`ari:review-drafts:${sessionId}`, JSON.stringify([stored]))
    expect(readReviewDrafts(sessionId)[0]?.id).toEqual(expect.any(String))
  })
})

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitReviewManifest } from '@ari/contracts/rpc'
import { useReviewPreferences } from './use-review-preferences'

const scopeId = 'a'.repeat(64)
const contentId = 'b'.repeat(64)
const manifest: GitReviewManifest = {
  id: 'c'.repeat(64),
  reviewScopeId: scopeId,
  comparison: { kind: 'working-tree' },
  baseOid: 'd'.repeat(40),
  headOid: 'e'.repeat(40),
  baseLabel: 'HEAD',
  headLabel: 'Working tree',
  branch: 'main',
  live: true,
  truncated: false,
  checkedAt: 1,
  files: [
    {
      path: 'a.ts',
      contentId,
      kind: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      staged: false,
      unstaged: true,
    },
  ],
}
const storageKey = 'ari:review:project'

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('review progress preferences', () => {
  it.each([
    '{broken',
    JSON.stringify({ viewed: [{ scopeId, path: '../secret', contentId }] }),
    JSON.stringify({ viewed: [{ scopeId, path: 'a.ts', contentId: null }] }),
    JSON.stringify({ viewed: [null, 'bad', { scopeId, path: 'a.ts', contentId: 'invalid' }] }),
  ])('ignores corrupt or invalid storage: %s', (raw) => {
    sessionStorage.setItem(storageKey, raw)
    const { result } = renderHook(() => useReviewPreferences('project'))
    expect(result.current.viewedPaths(manifest).size).toBe(0)
  })

  it('keeps older manifest marks transient when either identity is missing', () => {
    for (const legacy of [
      { ...manifest, reviewScopeId: undefined },
      { ...manifest, files: [{ ...manifest.files[0]!, contentId: undefined }] },
    ]) {
      const view = renderHook(() => useReviewPreferences('project'))
      act(() => view.result.current.markViewed(legacy, legacy.files[0]!, true))
      expect(view.result.current.viewedPaths(legacy).has('a.ts')).toBe(true)
      expect(view.result.current.viewedPaths({ ...legacy, id: 'f'.repeat(64) }).size).toBe(0)
      view.unmount()
      const remount = renderHook(() => useReviewPreferences('project'))
      expect(remount.result.current.viewedPaths(legacy).size).toBe(0)
      remount.unmount()
    }
  })

  it('bounds stored marks and retains the newest valid entries', () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        viewed: Array.from({ length: 5001 }, (_, index) => ({
          scopeId,
          path: index === 5000 ? 'a.ts' : `file-${index}.ts`,
          contentId,
        })),
      }),
    )
    const { result } = renderHook(() => useReviewPreferences('project'))
    expect(result.current.value.viewed).toHaveLength(5000)
    expect(result.current.value.viewed[0]?.path).toBe('file-1.ts')
    expect(result.current.viewedPaths(manifest).has('a.ts')).toBe(true)
    act(() => result.current.markViewed(manifest, { ...manifest.files[0]!, path: 'last.ts' }, true))
    expect(result.current.value.viewed).toHaveLength(5000)
    expect(result.current.value.viewed.at(-1)?.path).toBe('last.ts')
  })

  it('keeps review usable when storage cannot be read or written', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const view = renderHook(() => useReviewPreferences('project'))
    act(() => view.result.current.markViewed(manifest, manifest.files[0]!, true))
    expect(view.result.current.viewedPaths(manifest).has('a.ts')).toBe(true)
    expect(() => view.unmount()).not.toThrow()
  })
})

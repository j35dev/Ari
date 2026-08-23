import { describe, expect, it, vi } from 'vitest'
import type { GitError } from '@ari/engine/git'
import type { Result } from '@ari/shared/result'
import { queryTurnDiff } from './turn-diff'

type DiffFn = (cwd: string, gitRef: string) => Promise<Result<string, GitError>>

describe('queryTurnDiff', () => {
  it('returns the unified diff for an existing checkpoint', async () => {
    const diffForRef = vi
      .fn<DiffFn>()
      .mockResolvedValue({ ok: true, value: 'diff --git a/f b/f\n+line\n' })
    const result = await queryTurnDiff(diffForRef, {
      path: 'C:/repo',
      sessionId: 'sess_1',
      turnId: 'turn_2',
    })
    expect(result).toEqual({ diffText: 'diff --git a/f b/f\n+line\n' })
    expect(diffForRef).toHaveBeenCalledWith('C:/repo', 'refs/ari/sess_1/turn_2')
  })

  it('maps git failures to a null diff with the reason', async () => {
    const diffForRef = vi.fn<DiffFn>().mockResolvedValue({
      ok: false,
      error: { code: 'invalid_ref', message: "unknown revision 'refs/ari/s1/t1'" },
    })
    const result = await queryTurnDiff(diffForRef, {
      path: 'C:/repo',
      sessionId: 's1',
      turnId: 't1',
    })
    expect(result).toEqual({ diffText: null, error: "unknown revision 'refs/ari/s1/t1'" })
  })
})

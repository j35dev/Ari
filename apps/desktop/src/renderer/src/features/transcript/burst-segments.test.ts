import { describe, expect, it } from 'vitest'
import { burstSegments, exploreTally } from './burst-segments'
import type { TranscriptBlock } from './types'

function call(id: string, name: string, args: unknown): TranscriptBlock {
  return { key: id, kind: 'tool-call', callId: id, name, argsJson: JSON.stringify(args) }
}

describe('burstSegments', () => {
  it('folds runs of reads, searches and thoughts, and keeps commands and edits apart', () => {
    const steps: TranscriptBlock[] = [
      { key: 't1', kind: 'thinking', text: 'look first' },
      call('r1', 'Read', { file_path: 'a.ts' }),
      call('g1', 'Grep', { pattern: 'x' }),
      call('e1', 'Edit', { file_path: 'a.ts' }),
      call('r2', 'Read', { file_path: 'b.ts' }),
      call('b1', 'Bash', { command: 'pnpm test' }),
    ]
    const segments = burstSegments(steps)
    expect(segments.map((s) => s.kind)).toEqual(['explore', 'step', 'explore', 'step'])
    const first = segments[0]
    expect(first?.kind === 'explore' && first.blocks.map((b) => b.key)).toEqual(['t1', 'r1', 'g1'])
    expect(first?.kind === 'explore' && first.calls.map((b) => b.key)).toEqual(['r1', 'g1'])
    // Keyed by its first block, so the line keeps its identity as it grows.
    expect(first?.key).toBe('explore:t1')
  })

  it('tallies an exploration by files read and searches run', () => {
    expect(
      exploreTally([
        call('r1', 'Read', { file_path: 'a.ts' }),
        call('r2', 'Read', { file_path: 'b.ts' }),
        call('g1', 'Grep', { pattern: 'x' }),
      ]),
    ).toBe('2 files, 1 search')
    expect(exploreTally([call('g1', 'Grep', { pattern: 'x' })])).toBe('1 search')
  })
})

import { describe, expect, it } from 'vitest'
import { parseDiff } from './parseDiff'

const BODY_LINE_COUNT = 10_000
const LINES_PER_HUNK = 30 // 10 × (context, add, del)
const PARSE_BUDGET_MS = 500

/**
 * Builds a syntactically valid unified diff with exactly `totalLines` hunk-body
 * lines in a strict context/add/del rotation. Old/new counts per hunk are
 * tracked while emitting so every `@@` header matches its body.
 */
function buildSyntheticDiff(totalLines: number): string {
  const out = [
    'diff --git a/src/generated.ts b/src/generated.ts',
    'index 0000000..1111111 100644',
    '--- a/src/generated.ts',
    '+++ b/src/generated.ts',
  ]
  let oldNo = 1
  let newNo = 1
  let emitted = 0
  while (emitted < totalLines) {
    const headerOld = oldNo
    const headerNew = newNo
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    for (
      let i = 0;
      i < LINES_PER_HUNK && emitted < totalLines;
      i += 1, emitted += 1
    ) {
      switch (emitted % 3) {
        case 0:
          body.push(` ctx ${emitted}`)
          oldCount += 1
          newCount += 1
          oldNo += 1
          newNo += 1
          break
        case 1:
          body.push(`+add ${emitted}`)
          newCount += 1
          newNo += 1
          break
        default:
          body.push(`-del ${emitted}`)
          oldCount += 1
          oldNo += 1
      }
    }
    out.push(
      `@@ -${headerOld},${oldCount} +${headerNew},${newCount} @@ stress section`,
    )
    out.push(...body)
  }
  return out.join('\n')
}

describe('parseDiff stress budgets', () => {
  it('parses a 10k-line synthetic diff under the wall budget', () => {
    const diffText = buildSyntheticDiff(BODY_LINE_COUNT)
    const hunkCount = Math.ceil(BODY_LINE_COUNT / LINES_PER_HUNK)
    const bodyLines = diffText.split('\n').length - 4 - hunkCount
    expect(bodyLines).toBe(BODY_LINE_COUNT)

    const start = performance.now()
    const parsed = parseDiff(diffText)
    const elapsedMs = performance.now() - start

    expect(elapsedMs).toBeLessThan(PARSE_BUDGET_MS)

    // Structural sanity on the hot path output: one file, balanced hunks,
    // alternating add/del/context preserved through the parser.
    expect(parsed.files).toHaveLength(1)
    const file = parsed.files[0]
    expect(file?.path).toBe('src/generated.ts')
    expect(file?.hunks).toHaveLength(hunkCount)

    const lines = file?.hunks.flatMap((h) => h.lines) ?? []
    expect(lines).toHaveLength(BODY_LINE_COUNT)
    for (let i = 0; i < lines.length; i += 1) {
      const expected =
        i % 3 === 0 ? 'context' : i % 3 === 1 ? ('add' as const) : ('del' as const)
      expect(lines[i]?.type).toBe(expected)
    }
    const lastLine = lines.at(-1)
    expect(lastLine).toBeDefined()
    expect(lastLine?.newLineNo).toBeGreaterThan(0)
    expect(lastLine?.oldLineNo).toBeGreaterThan(0)
  })
})

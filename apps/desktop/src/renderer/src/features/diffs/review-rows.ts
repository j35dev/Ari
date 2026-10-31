import type { DiffFile, DiffLine } from './parseDiff'

export interface ReviewRow {
  old?: DiffLine
  next?: DiffLine
  header?: string
}

/** Aligns replacement runs while preserving source line numbers on both sides. */
export function reviewRows(file: DiffFile, split: boolean, ignoreWhitespace: boolean): ReviewRow[] {
  const rows: ReviewRow[] = []
  for (const hunk of file.hunks) {
    rows.push({ header: hunk.header })
    for (let at = 0; at < hunk.lines.length;) {
      const line = hunk.lines[at]!
      if (line.type === 'context') {
        rows.push({ old: line, next: line })
        at++
        continue
      }
      const old: DiffLine[] = []
      const next: DiffLine[] = []
      while (at < hunk.lines.length && hunk.lines[at]!.type !== 'context') {
        const change = hunk.lines[at++]!
        if (change.type === 'del') old.push(change)
        else next.push(change)
      }
      if (
        ignoreWhitespace &&
        old.length === next.length &&
        old.every(
          (line, i) => line.content.replace(/\s/g, '') === next[i]!.content.replace(/\s/g, ''),
        )
      )
        continue
      if (split)
        for (let i = 0; i < Math.max(old.length, next.length); i++)
          rows.push({ old: old[i], next: next[i] })
      else {
        rows.push(...old.map((old) => ({ old })), ...next.map((next) => ({ next })))
      }
    }
  }
  return rows
}

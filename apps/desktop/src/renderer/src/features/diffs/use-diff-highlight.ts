import { useEffect, useState } from 'react'
import type { ReviewRow } from './review-rows'
import { DiffHighlightPool, type HighlightLine } from './diff-highlight-pool'

const pool = new DiffHighlightPool()
const extensions: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  py: 'python',
  rs: 'rust',
  go: 'go',
  css: 'css',
  html: 'html',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  java: 'java',
  toml: 'toml',
  dockerfile: 'dockerfile',
}

/** Highlights bounded review text off-thread; plain text stays usable during loading/failure. */
export function useDiffHighlight(rows: ReviewRow[], path: string): Record<string, string> {
  const [value, setValue] = useState<{ rows: ReviewRow[]; html: Record<string, string> } | null>(
    null,
  )
  useEffect(() => {
    const lang = extensions[path.split('.').pop()?.toLowerCase() ?? '']
    if (!lang || typeof Worker === 'undefined') return
    const lines: HighlightLine[] = []
    let chars = 0
    for (const [index, row] of rows.entries()) {
      if (lines.length >= 4000) break
      for (const [side, line] of [
        ['old', row.old],
        ['new', row.next],
      ] as const) {
        if (!line || line.content.length > 2000) continue
        chars += line.content.length
        if (chars > 180_000) break
        lines.push({ key: `${index}:${side}`, side, text: line.content })
      }
      if (chars > 180_000) break
    }
    if (!lines.length) return
    let cancelled = false
    const request = pool.request(lang, lines)
    void request.promise.then((html) => {
      if (!cancelled) setValue({ rows, html })
    })
    return () => {
      cancelled = true
      request.cancel()
    }
  }, [rows, path])
  return value?.rows === rows ? value.html : {}
}

import type { GitReviewFile } from '@ari/contracts/rpc'

/** Joins complete NUL-delimited Git name/status and numstat records with index/worktree flags. */
export function parseReviewFiles(
  names: string,
  numstat: string,
  status: readonly GitReviewFile[],
): GitReviewFile[] {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const rows = numstat.split('\0')
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at] ?? ''
    const first = row.indexOf('\t')
    const second = row.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    let path = row.slice(second + 1)
    if (path === '') {
      at++
      path = rows[++at] ?? ''
    }
    if (!path) continue
    const added = row.slice(0, first)
    const removed = row.slice(first + 1, second)
    counts.set(path, {
      additions: /^\d+$/.test(added) ? Number(added) : 0,
      deletions: /^\d+$/.test(removed) ? Number(removed) : 0,
      binary: added === '-' || removed === '-',
    })
  }
  const existing = new Map(status.map((file) => [file.path, file]))
  const records = names.split('\0')
  const files: GitReviewFile[] = []
  for (let at = 0; at < records.length; at++) {
    const code = records[at]?.[0]
    if (!code) continue
    const oldPath = code === 'R' || code === 'C' ? records[++at] : undefined
    const path = records[++at]
    if (!path) continue
    const state = existing.get(path)
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      kind:
        state?.kind === 'untracked'
          ? 'untracked'
          : state?.kind === 'conflicted'
            ? 'conflicted'
            : code === 'A' || code === 'C'
              ? 'added'
              : code === 'D'
                ? 'deleted'
                : code === 'R'
                  ? 'renamed'
                  : code === 'U'
                    ? 'conflicted'
                    : 'modified',
      additions: counts.get(path)?.additions ?? 0,
      deletions: counts.get(path)?.deletions ?? 0,
      binary: counts.get(path)?.binary ?? false,
      staged: state?.staged ?? false,
      unstaged: state?.unstaged ?? false,
    })
  }
  return files
}

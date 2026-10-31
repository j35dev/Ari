import type { SourceControlStatus, GitReviewFile } from '@ari/contracts/rpc'

const kinds: Record<string, GitReviewFile['kind']> = {
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  U: 'conflicted',
  '?': 'untracked',
}

/** Parses NUL-delimited porcelain v2 without unquoting or splitting literal filenames. */
export function parseRepositoryStatus(output: string): SourceControlStatus {
  const status: SourceControlStatus = {
    branch: null,
    headOid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    remotes: [],
    operation: null,
  }
  const records = output.split('\0')
  for (let at = 0; at < records.length; at++) {
    const record = records[at] ?? ''
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice(14)
      status.branch = branch === '(detached)' ? null : branch
    } else if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13)
      status.headOid = /^[a-f0-9]{40,64}$/.test(oid) ? oid : null
    } else if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice(18)
    } else if (record.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      status.ahead = Number(counts?.[1] ?? 0)
      status.behind = Number(counts?.[2] ?? 0)
    } else if (record.startsWith('? ')) {
      status.files.push(entry(record.slice(2), '?', false, true))
    } else if (/^[12u] /.test(record)) {
      const count = record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10
      let position = 0
      const fields: string[] = []
      for (let field = 0; field < count; field++) {
        const space = record.indexOf(' ', position)
        if (space < 0) break
        fields.push(record.slice(position, space))
        position = space + 1
      }
      if (fields.length !== count || position >= record.length) continue
      const xy = fields[1] ?? '..'
      const staged = xy[0] !== '.'
      const unstaged = xy[1] !== '.'
      const file = entry(
        record.slice(position),
        record[0] === 'u' ? 'U' : ((staged ? xy[0] : xy[1]) ?? 'M'),
        staged,
        unstaged,
      )
      if (record[0] === '2') file.oldPath = records[++at]
      status.files.push(file)
    }
  }
  return status
}

function entry(path: string, kind: string, staged: boolean, unstaged: boolean): GitReviewFile {
  return {
    path,
    kind: kinds[kind] ?? 'modified',
    additions: 0,
    deletions: 0,
    binary: false,
    staged,
    unstaged,
  }
}

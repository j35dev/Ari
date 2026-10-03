/**
 * Pure unified-diff parser producing the hunk model the diff viewer renders.
 *
 * Handles `diff --git` preambles, `---`/`+++` path headers (including
 * `/dev/null`, quoted paths and tab-separated timestamps), `new file mode` /
 * `deleted file mode` / `rename from|to` metadata, `Binary files … differ`
 * markers, `GIT binary patch` bodies and `@@ -a,b +c,d @@ section` hunk
 * headers with omitted counts. `\ No newline at end of file` markers carry no
 * display value here and are skipped.
 */

/** Kind of a single line inside a hunk. */
export type DiffLineType = 'context' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  /** Line text without the leading diff marker character. */
  content: string
  /** 1-based line number in the old file; absent for pure additions. */
  oldLineNo?: number
  /** 1-based line number in the new file; absent for pure deletions. */
  newLineNo?: number
}

export interface DiffHunk {
  /** Raw `@@ -a,b +c,d @@ …` header line, preserved verbatim. */
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  /** Path in the new tree (old tree path for deletions). */
  path: string
  /** Original path when the file was renamed or is shown under both trees. */
  oldPath?: string
  isNew?: boolean
  isDeleted?: boolean
  isBinary?: boolean
  hunks: DiffHunk[]
}

export interface ParsedDiff {
  files: DiffFile[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function stripRevisionPrefix(token: string): string {
  return token.startsWith('a/') || token.startsWith('b/') ? token.slice(2) : token
}

/** Extracts the path from a `---`/`+++` header value; null for `/dev/null`. */
function headerPath(value: string): string | null {
  const tab = value.indexOf('\t')
  let token = tab === -1 ? value : value.slice(0, tab)
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    token = token.slice(1, -1)
  }
  if (token === '/dev/null') return null
  return stripRevisionPrefix(token)
}

/** Fallback path extraction from `diff --git a/<old> b/<new>` when no `---`/`+++` headers exist. */
function gitHeaderPaths(line: string): { oldPath: string; newPath: string } {
  const body = line.slice('diff --git '.length)
  const match = /^a\/(.*) b\/(.*)$/.exec(body)
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { oldPath: match[1], newPath: match[2] }
  }
  return { oldPath: body, newPath: body }
}

/**
 * Parses unified diff text into the structured hunk model. Lenient by design:
 * unknown input yields an empty file list rather than throwing, and hunk-body
 * consumption is bounded by the counts declared in each `@@` header so stray
 * content lines can never desynchronize line numbering.
 */
export function parseDiff(diffText: string): ParsedDiff {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldRemaining = 0
  let newRemaining = 0
  let oldNo = 0
  let newNo = 0

  const beginFile = (): DiffFile => {
    const file: DiffFile = { path: '', hunks: [] }
    files.push(file)
    hunk = null
    oldRemaining = 0
    newRemaining = 0
    return file
  }

  for (const raw of diffText.split(/\r?\n/)) {
    // Inside a hunk body the declared line counts decide consumption, so
    // content that merely looks like headers (`- --- a/x`) stays a diff line.
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = raw.charAt(0)
      if (marker === '\\') continue
      const type: DiffLineType =
        marker === '+' ? 'add' : marker === '-' ? 'del' : 'context'
      const line: DiffLine = { type, content: raw.slice(1) }
      if (marker !== '+') line.oldLineNo = oldNo++
      if (marker !== '-') line.newLineNo = newNo++
      hunk.lines.push(line)
      if (marker !== '+') oldRemaining--
      if (marker !== '-') newRemaining--
      continue
    }

    if (raw.startsWith('diff --git ')) {
      current = beginFile()
      // Provisional paths; refined by `---`/`+++`/rename headers below and
      // the only source for header-less chunks (binary files, mode changes).
      const paths = gitHeaderPaths(raw)
      current.path = paths.newPath
      current.oldPath = paths.oldPath
      continue
    }

    if (!current) {
      // Tolerate bare `---`/`+++` blocks without a `diff --git` preamble.
      if (!raw.startsWith('--- ') && !raw.startsWith('+++ ')) continue
      current = beginFile()
    }

    if (raw.startsWith('--- ')) {
      const old = headerPath(raw.slice(4))
      if (old === null) {
        current.isNew = true
        delete current.oldPath
      } else {
        current.oldPath = old
      }
      continue
    }

    if (raw.startsWith('+++ ')) {
      const fresh = headerPath(raw.slice(4))
      if (fresh === null) {
        current.isDeleted = true
        if (!current.path && current.oldPath) current.path = current.oldPath
      } else {
        current.path = fresh
      }
      continue
    }

    if (raw.startsWith('new file mode ')) {
      current.isNew = true
      continue
    }

    if (raw.startsWith('deleted file mode ')) {
      current.isDeleted = true
      continue
    }

    if (raw.startsWith('rename from ')) {
      current.oldPath = stripRevisionPrefix(raw.slice('rename from '.length))
      continue
    }

    if (raw.startsWith('rename to ')) {
      current.path = stripRevisionPrefix(raw.slice('rename to '.length))
      continue
    }

    if (raw.startsWith('Binary files ') && raw.endsWith(' differ')) {
      current.isBinary = true
      continue
    }

    if (raw === 'GIT binary patch') {
      current.isBinary = true
      continue
    }

    const header = HUNK_HEADER.exec(raw)
    if (header) {
      const [, oldStart, oldCount, newStart, newCount] = header
      hunk = { header: raw, lines: [] }
      current.hunks.push(hunk)
      oldNo = Number(oldStart)
      newNo = Number(newStart)
      oldRemaining = oldCount === undefined ? 1 : Number(oldCount)
      newRemaining = newCount === undefined ? 1 : Number(newCount)
      continue
    }

    // index/old mode/new mode/similarity lines and unknown preamble noise.
  }

  // The provisional `diff --git` old path is only meaningful when it differs
  // (renames); drop it for plain modifications and deletions.
  for (const file of files) {
    if (file.oldPath === file.path) delete file.oldPath
  }

  return { files }
}

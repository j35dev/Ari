import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { todoFilenameFor } from '@ari/ari-core/todo'
import { GitService, RepositoryGit } from '@ari/engine/git'
import { parseDiff } from '@ari/shared/diff-parse'
import type { SessionReadModel } from '@ari/engine/projection'
import type { RemoteFilesIndex } from '@ari/contracts/remote'
import { queryRemoteFiles, remotePathIsSafe } from './remote-files'
import { queryTurnDiff, queryTurnDiffFile } from './turn-diff'

export async function readRemotePlan(workspace: string, sessionId: string) {
  const read = await queryRemoteFiles(workspace, { op: 'files.read', path: todoFilenameFor(sessionId) })
  if (!('content' in read) || read.content === null) return { items: null }
  try { return { items: JSON.parse(read.content) as unknown } } catch { return { items: null } }
}

export async function indexRemoteFiles(workspace: string, cursor?: string, limit = 200): Promise<RemoteFilesIndex> {
  const pending = ['']
  const paths: string[] = []
  const start = Date.now()
  let count = 0
  let truncated = false
  while (pending.length) {
    if (count >= 20_000 || Date.now() - start > 3000) { truncated = true; break }
    const path = pending.pop()!
    let page: string | undefined
    do {
      const result = await queryRemoteFiles(workspace, { op: 'files.list', path, limit: 200, ...(page ? { cursor: page } : {}) })
      if (!('entries' in result) || result.error) { truncated = true; break }
      for (const entry of result.entries) {
        count++
        if (entry.kind === 'directory') {
          if (!['node_modules', 'vendor', '.cache'].includes(entry.name) && pending.length < 2000) pending.push(entry.path)
          else truncated = true
        } else if (cursor === undefined || entry.path > cursor) paths.push(entry.path)
      }
      page = result.nextCursor ?? undefined
      if (count >= 20_000 || Date.now() - start > 3000) { truncated = true; break }
    } while (page)
  }
  paths.sort()
  const selected = paths.slice(0, limit)
  return { paths: selected, nextCursor: paths.length > limit ? selected.at(-1) ?? null : null, truncated }
}

/** A generated destination, jailed before opening and checked through the opened handle. */
export async function stageRemotePaste(workspace: string, text: string) {
  const bytesWritten = Buffer.byteLength(text, 'utf8')
  if (bytesWritten > 256 * 1024 || text.includes('\0')) throw new Error('paste exceeds text limit')
  const root = await realpath(workspace)
  let parent = root
  for (const part of ['.ari', 'pastes']) {
    parent = join(parent, part)
    await mkdir(parent).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent) throw new Error('paste folder is unavailable')
  }
  const path = `.ari/pastes/${randomUUID()}.txt`
  const target = join(root, ...path.split('/'))
  if (!(await remotePathIsSafe(root, path))) throw new Error('paste folder is unavailable')
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const current = await lstat(target)
    const opened = await handle.stat()
    if (current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev ||
      !(await remotePathIsSafe(root, path))) throw new Error('paste folder changed')
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  return { path, bytesWritten }
}

/** Refuse link blobs even when a deleted link no longer exists in the working tree. */
export async function safeSnapshotPath(workspace: string, path: string, refs: readonly string[]): Promise<boolean> {
  if (!(await remotePathIsSafe(workspace, path))) return false
  for (const ref of refs) {
    const mode = await new RepositoryGit(workspace).run(['--literal-pathspecs', 'ls-tree', ref, '--', path], { maxBytes: 4096 })
    if (!mode.ok || mode.value.startsWith('120000 ')) return false
  }
  return true
}

export async function readRemoteTurnDiff(workspace: string, model: SessionReadModel, turnId: string) {
  const result = await queryTurnDiff(new GitService(), { path: workspace, turnId, checkpoints: model.checkpoints })
  const files = result.summary?.files ?? (result.diffText ? parseDiff(result.diffText) : [])
  for (const file of files) {
    const checkpoint = model.checkpoints.find((row) => row.turnId === turnId)
    const refs = result.summary ? [result.summary.baseOid, result.summary.headOid] : checkpoint ? [checkpoint.gitRef, ...(checkpoint.endRef ? [checkpoint.endRef] : [])] : []
    if (!(await safeSnapshotPath(workspace, file.path, refs)) || (file.oldPath && !(await safeSnapshotPath(workspace, file.oldPath, refs))))
      return { diffText: null, error: 'This turn includes files unavailable to remote clients.' }
  }
  return result
}

export async function readRemoteTurnFile(workspace: string, model: SessionReadModel, turnId: string, path: string) {
  const at = model.checkpoints.findIndex((row) => row.turnId === turnId)
  const start = model.checkpoints[at]
  if (!start || start.endError) return { diffText: null }
  const git = new GitService()
  let end = start.endRef ?? model.checkpoints[at + 1]?.gitRef
  if (!end) {
    const tree = await git.worktreeTree(workspace)
    if (!tree.ok) return { diffText: null, error: 'Turn snapshot is unavailable.' }
    end = tree.value
  }
  const base = await new RepositoryGit(workspace).run(['rev-parse', '--verify', '--end-of-options', `${start.gitRef}^{tree}`])
  const head = await new RepositoryGit(workspace).run(['rev-parse', '--verify', '--end-of-options', `${end}^{tree}`])
  if (!base.ok || !head.ok || !(await safeSnapshotPath(workspace, path, [base.value.trim(), head.value.trim()])))
    return { diffText: null, error: 'This file is unavailable to remote clients.' }
  return queryTurnDiffFile(workspace, { baseOid: base.value.trim(), headOid: head.value.trim(), path })
}

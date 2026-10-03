import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { remoteFilePathSchema, type RemoteFile, type RemoteFiles } from '@ari/contracts/remote'
import { createLogger } from '@ari/shared/logger'

const MAX_TEXT_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 2000
const log = createLogger('desktop:remote-files')

function excluded(name: string): boolean {
  const value = name.toLowerCase()
  return (
    [
      '.git',
      '.ssh',
      '.aws',
      '.netrc',
      '.npmrc',
      'auth.json',
      'credentials.json',
      'id_rsa',
      'id_ed25519',
    ].includes(value) ||
    /^\.env(?:\.|$)/.test(value) ||
    /\.(?:pem|key|p12|pfx)$/.test(value)
  )
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !child.includes(':'))
}

async function resolveFile(workspace: string, path: string): Promise<string | null> {
  if (!remoteFilePathSchema.safeParse(path).success || path.split('/').some(excluded)) return null
  const root = await realpath(workspace)
  let target = root
  for (const part of path === '' ? [] : path.split('/')) {
    target = join(target, part)
    if ((await lstat(target)).isSymbolicLink()) return null
  }
  const resolved = await realpath(target)
  return contained(root, resolved) ? resolved : null
}

/** Bounded, read-only files within the host-selected workspace; symlinks and credential files are excluded. */
export async function queryRemoteFiles(
  workspace: string,
  request: { op: 'files.list' | 'files.read'; path: string; cursor?: string; limit?: number },
): Promise<RemoteFiles | RemoteFile> {
  const unavailable =
    request.op === 'files.list'
      ? { path: request.path, entries: [], nextCursor: null, error: 'This folder is unavailable.' }
      : {
          path: request.path,
          kind: null,
          size: null,
          content: null,
          error: 'This file is unavailable.',
        }
  try {
    const target = await resolveFile(workspace, request.path)
    if (target === null) return unavailable
    if (request.op === 'files.list') {
      const entries: RemoteFiles['entries'] = []
      const dir = await opendir(target)
      let count = 0
      for await (const entry of dir) {
        if (++count > MAX_DIRECTORY_ENTRIES)
          return { ...unavailable, error: 'This folder exceeds the 2,000-entry limit.' }
        if (
          excluded(entry.name) ||
          !remoteFilePathSchema.safeParse(entry.name).success ||
          entry.isSymbolicLink() ||
          (!entry.isFile() && !entry.isDirectory())
        )
          continue
        const info = await lstat(join(target, entry.name))
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue
        entries.push({
          name: entry.name,
          path: request.path === '' ? entry.name : `${request.path}/${entry.name}`,
          kind: info.isDirectory() ? 'directory' : 'file',
          size: info.isFile() ? info.size : null,
        })
      }
      // The cursor order stays independent of file type so a rename/type change cannot reorder a page boundary.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const remaining = entries.filter(
        (entry) => request.cursor === undefined || entry.name > request.cursor,
      )
      const limit = Math.min(200, Math.max(1, request.limit ?? 100))
      const page = remaining.slice(0, limit)
      if ((await resolveFile(workspace, request.path)) !== target) return unavailable
      return {
        path: request.path,
        entries: page,
        nextCursor: remaining.length > limit ? (page.at(-1)?.name ?? null) : null,
        error: null,
      }
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat()
      const current = await lstat(target)
      // Validate the opened handle too: a replacement during open must not turn a contained path into an outside read.
      if (
        !info.isFile() ||
        info.ino !== current.ino ||
        info.dev !== current.dev ||
        current.isSymbolicLink() ||
        (await resolveFile(workspace, request.path)) !== target
      )
        return unavailable
      if (info.size > MAX_TEXT_BYTES)
        return {
          path: request.path,
          kind: 'too-large',
          size: info.size,
          content: null,
          error: null,
        }
      const bytes = Buffer.alloc(MAX_TEXT_BYTES + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > MAX_TEXT_BYTES)
        return {
          path: request.path,
          kind: 'too-large',
          size: bytesRead,
          content: null,
          error: null,
        }
      const body = bytes.subarray(0, bytesRead)
      let content: string | null = null
      if (!body.includes(0)) {
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(body)
        } catch {
          /* Non-UTF-8 files have metadata only. */
        }
      }
      return {
        path: request.path,
        kind: content === null ? 'binary' : 'text',
        size: info.size,
        content,
        error: null,
      }
    } finally {
      await handle.close()
    }
  } catch {
    log.warn('remote workspace file read unavailable')
    return unavailable
  }
}

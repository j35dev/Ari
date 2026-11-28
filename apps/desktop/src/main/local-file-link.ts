import { realpath, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RpcResults } from '@ari/contracts/rpc'
import { localPathKind, parseLocalFileLink } from '../shared/local-file-link'

// Unknown types may be executable, installers, or shortcuts. Reveal those instead.
const OPENABLE_FILE_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.avi',
  '.flac',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
  '.wmv',
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
  '.csv',
  '.doc',
  '.docx',
  '.epub',
  '.htm',
  '.html',
  '.ipynb',
  '.json',
  '.log',
  '.markdown',
  '.md',
  '.odp',
  '.ods',
  '.odt',
  '.pdf',
  '.ppt',
  '.pptx',
  '.rtf',
  '.tsv',
  '.txt',
  '.xls',
  '.xlsx',
  '.xml',
  '.yaml',
  '.yml',
  '.7z',
  '.gz',
  '.rar',
  '.tar',
  '.zip',
])

interface FileActions {
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

export async function openLocalFileLink(
  target: string,
  workspace: () => Promise<string | null>,
  actions: FileActions,
): Promise<RpcResults['shell.openLocalFile']> {
  const invalid = {
    opened: false,
    reason: 'This link does not point to a file or folder on this computer.',
  } as const
  const input = parseLocalFileLink(target)
  if (input === null) return invalid

  const nativeKind = process.platform === 'win32' ? 'windows' : 'posix'
  let path: string
  try {
    path = typeof input === 'string' ? input : fileURLToPath(input)
  } catch {
    return invalid
  }
  const kind = localPathKind(path)
  if (kind === 'relative') {
    const baseDir = await workspace()
    if (!baseDir)
      return { opened: false, reason: 'The chat workspace is unavailable for this relative link.' }
    if (localPathKind(baseDir) !== nativeKind) return invalid
    path = resolve(baseDir, path)
  } else if (kind !== nativeKind) {
    return invalid
  }

  const resolved = await realpath(path).catch(() => null)
  if (!resolved)
    return { opened: false, reason: 'The file or folder could not be found or accessed.' }
  if (localPathKind(resolved) !== nativeKind) return invalid
  const info = await stat(resolved).catch(() => null)
  if (!info || (!info.isFile() && !info.isDirectory())) return invalid

  const reveal = info.isDirectory()
    ? // Finder can treat a directory as a launchable package.
      process.platform === 'darwin'
    : !OPENABLE_FILE_EXTENSIONS.has(extname(resolved).toLowerCase()) ||
      (process.platform !== 'win32' && (info.mode & 0o111) !== 0)
  try {
    if (reveal) actions.showItemInFolder(resolved)
    else {
      const failure = await actions.openPath(resolved)
      if (failure) return { opened: false, reason: failure }
    }
  } catch {
    return { opened: false, reason: 'The system could not open the file or folder.' }
  }
  return { opened: true }
}

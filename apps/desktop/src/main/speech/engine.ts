import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { t, x } from 'tar'
import type { SpeechProgress } from '@ari/contracts/rpc'
import releaseData from './engine-releases.json'
import {
  DownloadChecksumError,
  downloadFile,
  verifyDownload,
  ensureFreeSpace,
  prunePartialDownloads,
  PARTIAL_DOWNLOAD_MAX_AGE,
} from './download'

export const ENGINE_VERSION = '0.4.1'
export const ENGINE_HEADER_HASH = 'f99ad4169374b8f3'
export interface EngineRelease {
  filename: string
  size: number
  sha256: string
  url: string
  files: Record<string, { size: number; sha256: string }>
}
const releases = releaseData as unknown as EngineRelease[]
export class EngineIoError extends Error {}
class EngineMismatchError extends Error {}
const TRANSIENT_IO_CODES = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'EMFILE',
  'ENFILE',
  'EIO',
  'ETXTBSY',
])
export function engineRelease(platform = process.platform, arch = process.arch) {
  const host = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform
  const cpu =
    arch === 'x64' ? 'x86_64' : platform === 'linux' && arch === 'arm64' ? 'aarch64' : arch
  const backend = platform === 'darwin' ? (arch === 'arm64' ? 'metal' : 'cpu') : 'cpu-vulkan'
  const filename = `transcribe-native-${ENGINE_VERSION}-${host}-${cpu}-${backend}.tar.gz`
  const release = releases.find((entry) => entry.filename === filename)
  if (!release) throw new Error(`Speech to text is not available on ${platform} ${arch} yet.`)
  return release
}

export async function verifyInstalledEngine(
  directory: string,
  full = true,
  release?: EngineRelease,
  verified?: (stamp: string) => void,
): Promise<string | null> {
  const expected = (release ?? engineRelease()).files
  for (let attempt = 0; ; attempt++) {
    try {
      if (!(await lstat(directory)).isDirectory()) return null
      const found = new Set<string>()
      const stamps: string[] = []
      const walk = async (relative = ''): Promise<void> => {
        for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
          const key = relative ? `${relative}/${entry.name}` : entry.name
          if (
            !expected[key] &&
            entry.isFile() &&
            (entry.name === '.DS_Store' ||
              entry.name.startsWith('._') ||
              ['thumbs.db', 'desktop.ini'].includes(entry.name.toLowerCase()))
          )
            continue
          if (entry.isDirectory()) {
            if (!Object.keys(expected).some((path) => path.startsWith(`${key}/`)))
              throw new EngineMismatchError('Unexpected engine directory.')
            await walk(key)
          } else {
            const file = expected[key]
            if (!entry.isFile() || !file) throw new EngineMismatchError('Unexpected engine file.')
            const path = join(directory, key)
            const info = await lstat(path)
            if (info.size !== file.size) throw new EngineMismatchError('Incomplete engine file.')
            stamps.push(`${key}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
            if (full) await verifyDownload(path, file.sha256)
            found.add(key)
          }
        }
      }
      await walk()
      if (found.size !== Object.keys(expected).length) return null
      const contractKey = [...found].find((key) => basename(key) === 'contract.json')
      const libraryKey = [...found].find((key) =>
        /^(transcribe\.dll|libtranscribe\.(dylib|so))$/.test(basename(key)),
      )
      if (!contractKey || !libraryKey) return null
      const contract: unknown = JSON.parse(await readFile(join(directory, contractKey), 'utf8'))
      if (
        typeof contract !== 'object' ||
        !contract ||
        !('version' in contract) ||
        !('header_hash' in contract) ||
        contract.version !== ENGINE_VERSION ||
        contract.header_hash !== ENGINE_HEADER_HASH
      )
        return null
      verified?.(stamps.sort().join('\n'))
      return join(directory, libraryKey)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        code === 'ENOENT' ||
        code === 'ENOTDIR' ||
        error instanceof DownloadChecksumError ||
        error instanceof EngineMismatchError ||
        error instanceof SyntaxError
      )
        return null
      if (code && TRANSIENT_IO_CODES.has(code) && attempt < 2) {
        await setTimeout(100 * (attempt + 1))
        continue
      }
      throw new EngineIoError(
        'Could not read the speech engine files. Close apps using these files and retry.',
        { cause: error },
      )
    }
  }
}

export async function installEngine(
  root: string,
  signal: AbortSignal,
  progress: (frame: SpeechProgress) => void,
  verified?: (stamp: string) => void,
): Promise<string> {
  const release = engineRelease()
  const archive = join(root, release.filename)
  const staging = join(root, `${ENGINE_VERSION}.staging`)
  const destination = join(root, ENGINE_VERSION)
  await mkdir(root, { recursive: true })
  await prunePartialDownloads(
    root,
    new Set([`${release.filename}.partial`]),
    PARTIAL_DOWNLOAD_MAX_AGE,
    '.partial',
  )
  if (
    !(await stat(archive).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }))
  ) {
    await downloadFile({
      id: 'engine',
      path: archive,
      url: release.url,
      size: release.size,
      sha256: release.sha256,
      signal,
      progress,
    })
  } else {
    try {
      await verifyDownload(archive, release.sha256)
    } catch (error) {
      if (error instanceof DownloadChecksumError) await rm(archive, { force: true })
      throw error
    }
  }
  let expandedSize = 0
  await t({
    file: archive,
    onReadEntry: (entry) => {
      expandedSize += entry.size
    },
  })
  await ensureFreeSpace(root, expandedSize)
  signal.throwIfAborted()
  progress({ id: 'engine', phase: 'installing', received: release.size, total: release.size })
  await rm(staging, { force: true, recursive: true })
  await mkdir(staging)
  try {
    await x({
      file: archive,
      cwd: staging,
      strict: true,
      filter: (_path, entry) =>
        'type' in entry && (entry.type === 'File' || entry.type === 'Directory'),
    })
    signal.throwIfAborted()
    const library = await verifyInstalledEngine(staging, true, undefined, verified)
    if (!library)
      throw new Error('The speech engine files did not pass verification. Download it again.')
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    await rm(archive, { force: true }).catch((error: unknown) =>
      console.warn('Could not clean the speech engine archive:', archive, error),
    )
    return join(destination, relative(staging, library))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new Error('The disk is full. Free some space and retry the speech engine download.', {
        cause: error,
      })
    throw error
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

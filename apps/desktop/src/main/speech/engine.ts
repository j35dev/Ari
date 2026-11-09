import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { t, x } from 'tar'
import type { SpeechProgress } from '@ari/contracts/rpc'
import releaseData from './engine-releases.json'
import { downloadFile, verifyDownload, ensureFreeSpace } from './download'

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
): Promise<string | null> {
  try {
    const expected = (release ?? engineRelease()).files
    if (!(await lstat(directory)).isDirectory()) return null
    const found = new Set<string>()
    const walk = async (relative = ''): Promise<void> => {
      for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
        const key = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(key)
        else {
          const file = expected[key]
          if (!entry.isFile() || !file) throw new Error('Unexpected engine file.')
          const path = join(directory, key)
          if ((await lstat(path)).size !== file.size) throw new Error('Incomplete engine file.')
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
    return join(directory, libraryKey)
  } catch {
    return null
  }
}

export async function installEngine(
  root: string,
  signal: AbortSignal,
  progress: (frame: SpeechProgress) => void,
): Promise<string> {
  const release = engineRelease()
  const archive = join(root, release.filename)
  const staging = join(root, `${ENGINE_VERSION}.staging`)
  const destination = join(root, ENGINE_VERSION)
  await mkdir(root, { recursive: true })
  if (!(await stat(archive).catch(() => null))) {
    await downloadFile({
      id: 'engine',
      path: archive,
      url: release.url,
      size: release.size,
      sha256: release.sha256,
      signal,
      progress,
    })
  }
  try {
    await verifyDownload(archive, release.sha256)
  } catch (error) {
    await rm(archive, { force: true })
    throw error
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
    if (!(await verifyInstalledEngine(staging)))
      throw new Error('The speech engine files did not pass verification. Download it again.')
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    await rm(archive, { force: true })
    return (await verifyInstalledEngine(destination))!
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

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { t, x } from 'tar'
import type { SpeechProgress } from '@ari/contracts/rpc'
import releases from './engine-releases.json'
import { downloadFile, verifyDownload, ensureFreeSpace } from './download'

export const ENGINE_VERSION = '0.4.1'
export function engineRelease(platform = process.platform, arch = process.arch) {
  const host = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform
  const cpu = arch === 'x64' ? 'x86_64' : platform === 'linux' ? 'aarch64' : arch
  const backend = platform === 'darwin' ? (arch === 'arm64' ? 'metal' : 'cpu') : 'cpu-vulkan'
  const filename = `transcribe-native-${ENGINE_VERSION}-${host}-${cpu}-${backend}.tar.gz`
  const release = releases.find((entry) => entry.filename === filename)
  if (!release) throw new Error(`Speech to text is not available on ${platform} ${arch} yet.`)
  return release
}

export async function findLibrary(directory: string): Promise<string | null> {
  const name =
    process.platform === 'win32'
      ? 'transcribe.dll'
      : process.platform === 'darwin'
        ? 'libtranscribe.dylib'
        : 'libtranscribe.so'
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const found = await findLibrary(path)
      if (found) return found
    }
  }
  return null
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
    if (!(await findLibrary(staging)))
      throw new Error('The speech engine download did not contain its library.')
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    await rm(archive, { force: true })
    return (await findLibrary(destination))!
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

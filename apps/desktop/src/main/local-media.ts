import { realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { RpcResults } from '@ari/contracts/rpc'
import { isLocalMediaPath } from '../shared/local-media'

export async function openLocalMedia(
  target: string,
  openPath: (path: string) => Promise<string>,
): Promise<RpcResults['shell.openMediaFile']> {
  const invalid = {
    opened: false,
    reason: 'This link must point to an audio or video file on this computer.',
  } as const
  const windows = process.platform === 'win32'
  let path: string
  try {
    if (/^file:/i.test(target)) {
      const url = new URL(target)
      if (url.hostname) return invalid
      path = fileURLToPath(url)
    } else {
      path = decodeURIComponent(target)
    }
  } catch {
    return invalid
  }
  if (!isLocalMediaPath(path, windows)) return invalid

  const resolved = await realpath(path).catch(() => null)
  if (resolved === null)
    return { opened: false, reason: 'The media file could not be found or accessed.' }
  if (!isLocalMediaPath(resolved, windows)) return invalid
  const info = await stat(resolved).catch(() => null)
  if (!info?.isFile()) return { opened: false, reason: 'The link does not point to a media file.' }

  const failure = await openPath(resolved).catch(
    () => 'The default player could not open this media file.',
  )
  if (failure) return { opened: false, reason: failure }
  return { opened: true }
}

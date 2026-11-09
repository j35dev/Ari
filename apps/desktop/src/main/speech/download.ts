import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SpeechProgress } from '@ari/contracts/rpc'

export async function prunePartialDownloads(
  directory: string,
  keep: Set<string>,
  maxAge = 7 * 24 * 60 * 60_000,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.gguf.partial') || keep.has(entry.name)) continue
    const path = join(directory, entry.name)
    const file = await stat(path).catch(() => null)
    if (file && Date.now() - file.mtimeMs >= maxAge) await rm(path, { force: true })
  }
}

export async function verifyDownload(path: string, expected: string): Promise<void> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  if (hash.digest('hex') !== expected)
    throw new Error('Download checksum did not match. Please download it again.')
}

export async function ensureFreeSpace(directory: string, bytes: number): Promise<void> {
  const disk = await statfs(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOSYS' || error.code === 'ENOTSUP') return null
    throw error
  })
  if (disk && disk.bavail * disk.bsize < bytes + 64 * 1024 * 1024) {
    throw new Error(
      'Not enough disk space. Free space on the drive containing Ari’s application data and try again.',
    )
  }
}

export async function downloadFile(options: {
  id: string
  url: string
  path: string
  size: number
  sha256: string
  signal: AbortSignal
  progress: (progress: SpeechProgress) => void
}): Promise<void> {
  const { id, path, size, signal, progress } = options
  await mkdir(dirname(path), { recursive: true })
  const partial = `${path}.partial`
  let received = (await stat(partial).catch(() => null))?.size ?? 0
  if (received > size) {
    await rm(partial)
    received = 0
  }
  await ensureFreeSpace(dirname(path), size - received)
  try {
    if (received < size) {
      const response = await fetch(options.url, {
        signal,
        headers: received ? { Range: `bytes=${received}-` } : {},
      })
      if (!response.ok || !response.body)
        throw new Error(`Download failed (${response.status}). Try again.`)
      if (response.status === 206) {
        if (!response.headers.get('content-range')?.startsWith(`bytes ${received}-`))
          throw new Error('The server returned an invalid download range.')
      } else received = 0
      const file = await open(partial, received ? 'a' : 'w')
      const reader = response.body.getReader()
      let lastProgress = 0
      try {
        while (true) {
          const { value: bytes, done } = await reader.read()
          if (done) break
          signal.throwIfAborted()
          if (received + bytes.length > size) throw new Error('Download was larger than expected.')
          // FileHandle.write can be short; writeFile writes the entire chunk.
          await file.writeFile(bytes)
          received += bytes.length
          if (Date.now() - lastProgress > 150) {
            progress({ id, phase: 'downloading', received, total: size })
            lastProgress = Date.now()
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
        await file.close()
      }
    }
    signal.throwIfAborted()
    if (received !== size) throw new Error('Download ended early. Retry to resume it.')
    progress({ id, phase: 'verifying', received, total: size })
    try {
      await verifyDownload(partial, options.sha256)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
    signal.throwIfAborted()
    await rename(partial, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC')
      throw new Error('The disk is full. Free some space and retry to resume the download.', {
        cause: error,
      })
    throw error
  }
}

import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJsonLines, type ParsedLine } from '@ari/shared/jsonl'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:journal')

export interface JournalOptions {
  /** Directory that holds the journal segments. Created if missing. */
  dir: string
  /** Base file name without extension, e.g. `sess_123`. */
  name: string
  /** Rotate the active segment once it exceeds this many bytes. Default 8 MiB. */
  rotateBytes?: number
  /**
   * Durability policy: `always` fsyncs every append (default), `batch` lets
   * the OS decide until {@link Journal.flush} is called.
   */
  fsync?: 'always' | 'batch'
}

interface SegmentInfo {
  index: number
  path: string
}

/**
 * Append-only JSONL journal with size-based rotation and crash-tail
 * recovery. Segments are `<name>.<index>.jsonl`; index 0 is oldest.
 *
 * Crash safety: each line is a single `write` of complete JSON followed by
 * `\n`. A torn final line (partial write) is detected on read and reported
 * as an error entry; appends after recovery start on a fresh line boundary.
 */
export class Journal<T> {
  readonly #opts: Required<Pick<JournalOptions, 'dir' | 'name' | 'rotateBytes' | 'fsync'>>
  #activePath = ''
  #activeIndex = 0
  #activeSize = 0
  #handle: Awaited<ReturnType<typeof open>> | null = null

  constructor(options: JournalOptions) {
    this.#opts = {
      dir: options.dir,
      name: options.name,
      rotateBytes: options.rotateBytes ?? 8 * 1024 * 1024,
      fsync: options.fsync ?? 'always',
    }
  }

  /**
   * Opens (or creates) the journal and positions the active segment. A second
   * call closes the handle it already holds, so reopening never leaks one.
   */
  async open(): Promise<void> {
    await this.close()
    await mkdir(this.#opts.dir, { recursive: true })
    const segments = await this.#listSegments()
    if (segments.length === 0) {
      this.#activeIndex = 0
      this.#activePath = this.#segmentPath(0)
      this.#activeSize = 0
      this.#handle = await open(this.#activePath, 'a')
      return
    }
    const last = segments[segments.length - 1] as SegmentInfo
    this.#activeIndex = last.index
    this.#activePath = last.path
    const stat = await this.#handleStat(last.path)
    this.#activeSize = stat
    this.#handle = await open(this.#activePath, 'a')
  }

  /**
   * Appends one event as a JSONL line. `serialized` is `JSON.stringify(event)`
   * when the caller already holds it, so a hot path never encodes twice.
   */
  async append(event: T, serialized: string = JSON.stringify(event)): Promise<void> {
    if (!this.#handle) throw new Error('journal not opened')
    if (this.#activeSize >= this.#opts.rotateBytes) await this.#rotate()
    const buffer = Buffer.from(`${serialized}\n`, 'utf8')
    await this.#handle.write(buffer)
    if (this.#opts.fsync === 'always') await this.#handle.sync()
    this.#activeSize += buffer.byteLength
  }

  /**
   * Adds a missing final newline without discarding any bytes, including corrupt
   * tails that callers need to quarantine. Returns the number of bytes added.
   */
  async ensureTrailingNewline(): Promise<number> {
    if (!this.#handle) throw new Error('journal not opened')
    if (this.#activeSize === 0) return 0
    const reader = await open(this.#activePath, 'r')
    const lastByte = Buffer.alloc(1)
    try {
      await reader.read(lastByte, 0, 1, this.#activeSize - 1)
    } finally {
      await reader.close()
    }
    if (lastByte[0] === 0x0a) return 0
    await this.#handle.write(Buffer.from('\n'))
    this.#activeSize += 1
    if (this.#opts.fsync === 'always') await this.#handle.sync()
    return 1
  }

  /** Durability barrier for `fsync: 'batch'` mode; no-op in `always` mode. */
  async flush(): Promise<void> {
    if (this.#handle && this.#opts.fsync === 'batch') await this.#handle.sync()
  }

  /**
   * Reads every entry across all segments in order. Corrupt lines (including
   * a torn tail from a crash) are reported as `error` entries with their
   * absolute line number within their segment, never thrown.
   */
  async readAll(): Promise<ParsedLine<T>[]> {
    const out: ParsedLine<T>[] = []
    for await (const chunk of this.readByChunk()) out.push(...chunk)
    return out
  }

  /**
   * Reads every entry as bounded chunks, parsed one segment at a time. A
   * long session replays without holding the whole journal (and a split of
   * it) resident at once, and the event loop is pumped between segments so
   * pending IPC and timers are served instead of one multi-second block.
   * Chunk boundaries follow `raw` text length, so they stay near
   * `maxChunkChars` and only split between lines.
   */
  async *readByChunk(maxChunkChars = 256 * 1024): AsyncGenerator<ParsedLine<T>[]> {
    const segments = await this.#listSegments()
    let chunk: ParsedLine<T>[] = []
    let bytes = 0
    const take = (): ParsedLine<T>[] => {
      if (chunk.length === 0) return []
      const taken = chunk
      chunk = []
      bytes = 0
      return taken
    }
    for (const segment of segments) {
      let content: string
      try {
        content = await readFile(segment.path, 'utf8')
      } catch (e) {
        log.warn('segment unreadable, skipping', { path: segment.path, error: String(e) })
        continue
      }
      const parsed = parseJsonLines<T>(content)
      if (parsed.length === 0) continue
      for (let i = 0; i < parsed.length; i++) {
        const line = parsed[i] as ParsedLine<T>
        chunk.push(line)
        bytes += line.raw.length
        if (bytes >= maxChunkChars || i === parsed.length - 1) {
          const taken = take()
          if (taken.length > 0) yield taken
        }
        if (i === parsed.length - 1) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    if (chunk.length > 0) yield take()
  }

  /**
   * Drops a corrupt trailing partial line or terminates a valid final record
   * so future appends stay parseable. Returns the number of bytes truncated.
   */
  async repairTail(): Promise<number> {
    const entries = await this.readAll()
    const last = entries[entries.length - 1]
    if (!last || last.kind !== 'error') {
      await this.ensureTrailingNewline()
      return 0
    }
    const content = await readFile(this.#activePath, 'utf8')
    const cut = content.lastIndexOf('\n')
    let truncatedBytes: number
    if (cut === -1) {
      truncatedBytes = Buffer.byteLength(content, 'utf8')
      await this.#handle?.close()
      await open(this.#activePath, 'w').then((h) => h.close())
    } else {
      const good = Buffer.byteLength(content.slice(0, cut + 1), 'utf8')
      truncatedBytes = Buffer.byteLength(content.slice(cut + 1), 'utf8')
      const handle = await open(this.#activePath, 'r+')
      try {
        await handle.truncate(good)
      } finally {
        await handle.close()
      }
    }
    // Reopen in append mode so subsequent writes land at the fresh tail.
    await this.#handle?.close().catch(() => undefined)
    this.#handle = await open(this.#activePath, 'a')
    this.#activeSize = cut === -1 ? 0 : Buffer.byteLength(content.slice(0, cut + 1), 'utf8')
    return truncatedBytes
  }

  async close(): Promise<void> {
    if (this.#handle) {
      await this.#handle.sync().catch(() => undefined)
      await this.#handle.close()
      this.#handle = null
    }
  }

  #segmentPath(index: number): string {
    return join(this.#opts.dir, `${this.#opts.name}.${String(index).padStart(4, '0')}.jsonl`)
  }

  async #listSegments(): Promise<SegmentInfo[]> {
    const pattern = new RegExp(`^${this.#opts.name}\\.(\\d{4})\\.jsonl$`)
    let names: string[]
    try {
      names = await readdir(this.#opts.dir)
    } catch {
      return []
    }
    const segments: SegmentInfo[] = []
    for (const name of names) {
      const match = pattern.exec(name)
      if (match?.[1]) segments.push({ index: Number(match[1]), path: join(this.#opts.dir, name) })
    }
    segments.sort((a, b) => a.index - b.index)
    return segments
  }

  async #rotate(): Promise<void> {
    await this.close()
    this.#activeIndex += 1
    this.#activePath = this.#segmentPath(this.#activeIndex)
    this.#activeSize = 0
    this.#handle = await open(this.#activePath, 'a')
  }

  async #handleStat(path: string): Promise<number> {
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      return stat.size
    } finally {
      await handle.close()
    }
  }
}

/** Deletes every segment for a journal (used by session deletion). */
export async function destroyJournal(dir: string, name: string): Promise<void> {
  const pattern = new RegExp(`^${name}\\.\\d{4}\\.jsonl$`)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const fileName of names) {
    if (pattern.test(fileName)) await unlink(join(dir, fileName)).catch(() => undefined)
  }
}

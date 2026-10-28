import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A bot's memory is prompt material, so it stays small enough to always send. */
export const BOT_MEMORY_MAX_CHARS = 4_000

const BOT_ID = /^bot_[\w-]+$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Windows AV and indexers can hold the target briefly; retry like projects.ts. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, data, 'utf8')
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  await writeFile(path, data, 'utf8')
}

function checkBot(id: string): void {
  if (!BOT_ID.test(id)) throw new Error('unknown bot')
}

function checkCap(content: string): void {
  if (content.length > BOT_MEMORY_MAX_CHARS)
    throw new Error(
      `memory would be ${String(content.length)} characters; the cap is ${String(BOT_MEMORY_MAX_CHARS)}`,
    )
}

function requireText(value: string, label: string): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`${label} is empty`)
  return text
}

/**
 * A Hive bot's editable memory, one markdown file per bot beside its persona.
 *
 * A session's prompt must not change under it mid-conversation, so the first
 * turn of a session freezes the live memory into a per-session snapshot and
 * every later rebuild of the preamble reads that snapshot. Edits therefore
 * reach the next session, never the running one.
 */
export class BotMemoryStore {
  readonly #botsDir: string

  constructor(options: { dir: string }) {
    this.#botsDir = options.dir
  }

  #memoryPath(botId: string): string {
    checkBot(botId)
    return join(this.#botsDir, botId, 'memory.md')
  }

  async read(botId: string): Promise<string> {
    try {
      return await readFile(this.#memoryPath(botId), 'utf8')
    } catch {
      return ''
    }
  }

  /** Appends one memory line. */
  async add(botId: string, value: string): Promise<string> {
    const text = requireText(value, 'memory text')
    const current = (await this.read(botId)).trimEnd()
    const next = current.length === 0 ? `${text}\n` : `${current}\n\n${text}\n`
    checkCap(next)
    await this.#write(botId, next)
    return next
  }

  /** Replaces the first occurrence of `find` with `value`. */
  async patch(botId: string, find: string, value: string): Promise<string> {
    const needle = requireText(find, 'text to replace')
    const replacement = requireText(value, 'replacement text')
    const current = await this.read(botId)
    if (!current.includes(needle)) throw new Error('memory does not contain the text to replace')
    const next = current.replace(needle, replacement)
    checkCap(next)
    await this.#write(botId, next)
    return next
  }

  /** Removes the first occurrence of `find`. */
  async remove(botId: string, find: string): Promise<string> {
    const needle = requireText(find, 'text to remove')
    const current = await this.read(botId)
    if (!current.includes(needle)) throw new Error('memory does not contain the text to remove')
    const next = current
      .replace(needle, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
    await this.#write(botId, next.length === 0 ? '' : `${next}\n`)
    return next
  }

  /**
   * The memory this session was born with. The first call writes it; later
   * calls return the same text even after the live file changed.
   */
  async snapshot(botId: string, sessionId: string): Promise<string> {
    checkBot(botId)
    if (!SESSION_ID.test(sessionId)) throw new Error('unknown session')
    const path = join(this.#botsDir, botId, 'snapshots', `${sessionId}.md`)
    try {
      return await readFile(path, 'utf8')
    } catch {
      const live = await this.read(botId)
      await mkdir(join(this.#botsDir, botId, 'snapshots'), { recursive: true })
      await writeAtomic(path, live)
      return live
    }
  }

  async #write(botId: string, content: string): Promise<void> {
    await mkdir(join(this.#botsDir, botId), { recursive: true })
    await writeAtomic(this.#memoryPath(botId), content)
  }
}

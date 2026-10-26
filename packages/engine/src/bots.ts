import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { botSchema } from '@ari/contracts/bot'
import type { Bot } from '@ari/contracts/bot'
import { newTypedId } from '@ari/shared/ids'

const BOT_ID = /^bot_[\w-]+$/

export interface BotStoreOptions {
  /** Directory holding one folder per bot (typically <userData>/bots). */
  dir: string
}

/**
 * Hive bots on disk. Each bot is a folder containing `bot.json` (the record
 * without its persona) and `persona.md`; the JSON file's presence is what
 * makes the bot exist.
 */
export class BotStore {
  readonly #dir: string

  constructor(options: BotStoreOptions) {
    this.#dir = options.dir
  }

  async create(input: Omit<Bot, 'id'>): Promise<Bot> {
    const bot = botSchema.parse({ ...input, id: newTypedId('bot') })
    const dir = join(this.#dir, bot.id)
    await mkdir(dir, { recursive: true })
    const { personaMd, ...record } = bot
    await writeFile(join(dir, 'persona.md'), personaMd, 'utf8')
    await writeFile(join(dir, 'bot.json'), JSON.stringify(record, null, 2), 'utf8')
    return bot
  }

  async get(id: string): Promise<Bot | null> {
    if (!BOT_ID.test(id)) return null
    const dir = join(this.#dir, id)
    let record: unknown
    try {
      record = JSON.parse(await readFile(join(dir, 'bot.json'), 'utf8'))
    } catch {
      return null
    }
    let personaMd = ''
    try {
      personaMd = await readFile(join(dir, 'persona.md'), 'utf8')
    } catch {
      // A missing persona leaves the bot without instructions, not missing.
    }
    const parsed = botSchema.safeParse({ ...(record as object), personaMd })
    return parsed.success ? parsed.data : null
  }

  async list(): Promise<Bot[]> {
    let entries: string[]
    try {
      entries = await readdir(this.#dir)
    } catch {
      return []
    }
    const bots = await Promise.all(entries.map((entry) => this.get(entry)))
    return bots
      .filter((bot): bot is Bot => bot !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }
}

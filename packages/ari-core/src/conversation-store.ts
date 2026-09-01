import type { ChatMessage } from './protocols/openai-chat'

/**
 * Conversation memory for the Ari Core harness.
 *
 * CLI drivers resume their own provider-side thread through `resumeOf`; Ari
 * Core owns its transcript instead, so without a store every turn would start
 * from an empty conversation and the model would forget the turn before it.
 * Messages are keyed by Ari session id and hold the harness view of the
 * exchange (user text, assistant tool calls, tool results) — never the system
 * prompt, which is rebuilt each turn so environment facts stay current.
 */
export interface ConversationStore {
  load(sessionId: string): Promise<ChatMessage[]>
  save(sessionId: string, messages: ChatMessage[]): Promise<void>
  clear(sessionId: string): Promise<void>
}

/** Process-lifetime store; the default when no directory is configured. */
export class MemoryConversationStore implements ConversationStore {
  readonly #bySession = new Map<string, ChatMessage[]>()

  load(sessionId: string): Promise<ChatMessage[]> {
    return Promise.resolve([...(this.#bySession.get(sessionId) ?? [])])
  }

  save(sessionId: string, messages: ChatMessage[]): Promise<void> {
    this.#bySession.set(sessionId, [...messages])
    return Promise.resolve()
  }

  clear(sessionId: string): Promise<void> {
    this.#bySession.delete(sessionId)
    return Promise.resolve()
  }
}

/**
 * Disk-backed store: one JSON file per session under `dir`, written
 * atomically. Reads fail soft — a missing or corrupt file yields an empty
 * conversation rather than breaking the turn.
 */
export class FileConversationStore implements ConversationStore {
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  async load(sessionId: string): Promise<ChatMessage[]> {
    const { readFile } = await import('node:fs/promises')
    try {
      const raw = await readFile(this.#pathFor(sessionId), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(isChatMessage) : []
    } catch {
      return []
    }
  }

  async save(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const { mkdir, writeFile, rename } = await import('node:fs/promises')
    await mkdir(this.#dir, { recursive: true })
    const target = this.#pathFor(sessionId)
    await writeFile(`${target}.tmp`, JSON.stringify(messages), 'utf8')
    await rename(`${target}.tmp`, target)
  }

  async clear(sessionId: string): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(this.#pathFor(sessionId), { force: true })
  }

  #pathFor(sessionId: string): string {
    // Session ids come from the engine, but a path separator would escape the
    // directory — sanitize rather than trust.
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
    return `${this.#dir}/${safe}.json`
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    (record['role'] === 'system' ||
      record['role'] === 'user' ||
      record['role'] === 'assistant' ||
      record['role'] === 'tool') &&
    typeof record['content'] === 'string'
  )
}

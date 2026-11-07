import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { SecretBox } from '@ari/ari-core/endpoints'
import {
  sourceControlSchemas,
  type SourceControlConnect,
  type SourceControlConnection,
} from '@ari/contracts/rpc'

const saved = sourceControlSchemas.connection
  .omit({ hasToken: true })
  .extend({ cipher: z.string().nullable() })

/** Small encrypted host store. The renderer receives account metadata, never stored tokens. */
export class SourceControlConnections {
  #entries: z.infer<typeof saved>[]
  constructor(
    readonly file: string,
    readonly box: SecretBox,
  ) {
    this.#entries = existsSync(file)
      ? z.array(saved).parse(JSON.parse(readFileSync(file, 'utf8')))
      : []
  }

  list(): SourceControlConnection[] {
    return this.#entries.map(({ cipher, ...entry }) => ({ ...entry, hasToken: cipher !== null }))
  }

  credential(instance: string): { token: string; username: string } | null {
    const entry = this.#entries.find((entry) => entry.instance === normalizeInstance(instance))
    if (!entry?.cipher) return null
    const token = this.box.decrypt(entry.cipher)
    if (!token)
      throw new Error(
        'The saved hosting token could not be decrypted. Reconnect in Source control settings.',
      )
    return { token, username: entry.username }
  }

  save(input: SourceControlConnect, account: string | null): SourceControlConnection {
    const instance = normalizeInstance(input.instance)
    const existing = this.#entries.find((entry) => entry.instance === instance)
    const entry = saved.parse({
      id: existing?.id ?? randomUUID(),
      provider: input.provider,
      instance,
      username: input.username,
      account,
      cipher: input.token ? this.box.encrypt(input.token) : null,
    })
    const next = [...this.#entries.filter((entry) => entry.instance !== instance), entry]
    this.#write(next)
    return this.list().find((item) => item.id === entry.id)!
  }

  remove(id: string): boolean {
    const next = this.#entries.filter((entry) => entry.id !== id)
    if (next.length === this.#entries.length) return false
    this.#write(next)
    return true
  }

  #write(next: z.infer<typeof saved>[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(temp, this.file)
    this.#entries = next
  }
}

export function normalizeInstance(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}

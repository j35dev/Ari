import { z } from 'zod'

/**
 * A user-configured MCP server spawned over stdio for Ari Core turns.
 * Persisted as `mcp-servers.json` inside an injectable directory;
 * disabled entries stay on disk but are skipped at mount time.
 */
export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  disabled: z.boolean().default(false),
})
export type McpServerConfig = z.infer<typeof mcpServerSchema>

export interface McpServerStoreOptions {
  /** Directory holding mcp-servers.json (typically <userData>/ari-core). */
  dir: string
}

/**
 * CRUD store for MCP server definitions with atomic writes, mirroring the
 * EndpointStore pattern. A missing or corrupt file loads as empty — the
 * store never throws for bad disk state.
 */
export class McpServerStore {
  readonly #dir: string
  #servers: McpServerConfig[] = []

  constructor(options: McpServerStoreOptions) {
    this.#dir = options.dir
  }

  async load(): Promise<McpServerConfig[]> {
    const { readFile } = await import('node:fs/promises')
    try {
      const raw = await readFile(`${this.#dir}/mcp-servers.json`, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.#servers = z.array(mcpServerSchema).parse(parsed)
    } catch {
      this.#servers = []
    }
    return this.list()
  }

  list(): McpServerConfig[] {
    return this.#servers.map((s) => ({ ...s }))
  }

  /** Enabled (non-disabled) servers — the set a turn mounts. */
  enabled(): McpServerConfig[] {
    return this.list().filter((s) => !s.disabled)
  }

  async upsert(input: {
    id: string
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
    disabled?: boolean
  }): Promise<McpServerConfig> {
    const validated = mcpServerSchema.parse({
      id: input.id,
      name: input.name,
      command: input.command,
      args: input.args ?? [],
      env: input.env ?? {},
      disabled: input.disabled ?? false,
    })
    this.#servers = [...this.#servers.filter((s) => s.id !== validated.id), validated]
    await this.#persist()
    return { ...validated }
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#servers.length
    this.#servers = this.#servers.filter((s) => s.id !== id)
    if (this.#servers.length === before) return false
    await this.#persist()
    return true
  }

  async #persist(): Promise<void> {
    const { mkdir, rename, writeFile } = await import('node:fs/promises')
    await mkdir(this.#dir, { recursive: true })
    await writeFile(
      `${this.#dir}/mcp-servers.json.tmp`,
      JSON.stringify(this.#servers, null, 2),
      'utf8',
    )
    await rename(`${this.#dir}/mcp-servers.json.tmp`, `${this.#dir}/mcp-servers.json`)
  }
}

import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpConnection } from './mcp'
import { McpServerStore } from './mcp-servers'
import { mountMcpTools, mcpToolName, sanitizeMcpSegment } from './mcp-tools'

/**
 * Minimal MCP stdio server used as the fake remote: answers initialize,
 * lists one `echo` tool, echoes calls. `--silent` never replies (for
 * handshake-timeout tests); a `boom` tool returns an isError result.
 */
const FAKE_SERVER = `
import readline from 'node:readline'

const silent = process.argv.includes('--silent')

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

const tools = [
  {
    name: 'echo',
    description: 'Echoes text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
]

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (silent) return
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.1.0' },
      },
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
    return
  }
  if (msg.method === 'tools/call') {
    if (msg.params?.name === 'boom') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'kaboom' }], isError: true },
      })
      return
    }
    const text = msg.params?.arguments?.text ?? ''
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + text }] } })
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
`

async function writeFakeServer(dir: string): Promise<string> {
  const script = join(dir, 'fake-mcp-server.mjs')
  await writeFile(script, FAKE_SERVER, 'utf8')
  return script
}

function serverConfig(scriptPath: string) {
  return { name: 'fake', command: process.execPath, args: [scriptPath], env: {} }
}

describe('McpConnection', () => {
  it('handshakes over stdio, lists one tool, and echoes a call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-'))
    let connection: McpConnection | null = null
    try {
      const script = await writeFakeServer(dir)
      connection = await McpConnection.connect(serverConfig(script), { cwd: dir })

      const tools = await connection.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]?.name).toBe('echo')
      expect(tools[0]?.description).toContain('Echoes')

      const result = await connection.callTool('echo', { text: 'ping' })
      expect(result).toBe('echo: ping')
    } finally {
      await connection?.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces isError results as thrown errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-err-'))
    let connection: McpConnection | null = null
    try {
      const script = await writeFakeServer(dir)
      connection = await McpConnection.connect(serverConfig(script), { cwd: dir })
      await expect(connection.callTool('boom', {})).rejects.toThrow(/kaboom/)
    } finally {
      await connection?.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects connect when the server never answers initialize', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-hang-'))
    try {
      const script = await writeFakeServer(dir)
      const config = {
        name: 'hungry',
        command: process.execPath,
        args: [script, '--silent'],
        env: {},
      }
      await expect(
        McpConnection.connect(config, { cwd: dir, timeoutMs: 250 }),
      ).rejects.toThrow(/timed out after 250ms/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects connect when the command cannot spawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-dead-'))
    try {
      const config = {
        name: 'ghost',
        command: 'definitely-not-a-real-binary-xyz',
        args: [],
        env: {},
      }
      await expect(McpConnection.connect(config, { timeoutMs: 1_000 })).rejects.toThrow(
        /ghost/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mountMcpTools', () => {
  it('normalizes names into prefixed Ari tool names', () => {
    expect(sanitizeMcpSegment('GitHub API!')).toBe('github_api')
    expect(sanitizeMcpSegment('')).toBe('x')
    expect(mcpToolName('Fake Server', 'echo/text')).toBe('mcp_fake_server_echo_text')
  })

  it('maps listed tools onto the loop Tool shape with pass-through execute', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-mount-'))
    let connection: McpConnection | null = null
    try {
      const script = await writeFakeServer(dir)
      connection = await McpConnection.connect(serverConfig(script), { cwd: dir })
      const tools = await mountMcpTools([{ name: 'fake', connection }])

      expect(tools).toHaveLength(1)
      const tool = tools[0]
      expect(tool?.name).toBe('mcp_fake_echo')
      expect(tool?.description).toContain('Echoes')
      expect(tool?.parameters).toMatchObject({ type: 'object' })
      expect(await tool?.execute({ text: 'through the loop' }, {
        workspacePath: dir,
      })).toBe('echo: through the loop')
    } finally {
      await connection?.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('omits servers whose listing fails instead of throwing', async () => {
    const dead = {
      name: 'dead',
      // A connection stub whose listTools rejects, as a failed server would.
      connection: {
        listTools: async () => {
          throw new Error('server gone')
        },
      } as unknown as McpConnection,
    }
    const tools = await mountMcpTools([dead])
    expect(tools).toEqual([])
  })
})

describe('McpServerStore', () => {
  it('round-trips configs through mcp-servers.json and filters disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-store-'))
    try {
      const store = new McpServerStore({ dir })
      await store.upsert({ id: 'a', name: 'Fetch', command: 'npx', args: ['-y', 'fetch'] })
      await store.upsert({ id: 'b', name: 'Git', command: 'git-mcp', disabled: true })
      expect(store.list()).toHaveLength(2)
      expect(store.enabled().map((s) => s.id)).toEqual(['a'])

      const reloaded = new McpServerStore({ dir })
      const servers = await reloaded.load()
      expect(servers).toHaveLength(2)
      expect(servers.find((s) => s.id === 'a')).toMatchObject({
        name: 'Fetch',
        command: 'npx',
        args: ['-y', 'fetch'],
        env: {},
        disabled: false,
      })
      expect(reloaded.enabled().map((s) => s.id)).toEqual(['a'])
      expect(await readFile(join(dir, 'mcp-servers.json'), 'utf8')).toContain('"Fetch"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('upsert replaces by id and remove drops entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-store-'))
    try {
      const store = new McpServerStore({ dir })
      await store.upsert({ id: 'a', name: 'Old', command: 'old-cmd' })
      await store.upsert({ id: 'a', name: 'New', command: 'new-cmd' })
      await store.upsert({ id: 'b', name: 'Other', command: 'other-cmd' })
      expect(store.list().map((s) => s.name)).toEqual(['New', 'Other'])
      expect(await store.remove('a')).toBe(true)
      expect(await store.remove('missing')).toBe(false)
      expect(store.list().map((s) => s.id)).toEqual(['b'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads empty instead of throwing on missing or corrupt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-store-'))
    try {
      const missing = new McpServerStore({ dir: join(dir, 'absent') })
      expect((await missing.load()).length).toBe(0)

      await writeFile(join(dir, 'mcp-servers.json'), '{ not json', 'utf8')
      const corrupt = new McpServerStore({ dir })
      expect((await corrupt.load()).length).toBe(0)

      await writeFile(join(dir, 'mcp-servers.json'), '[{ "id": "x" }]', 'utf8')
      const invalid = new McpServerStore({ dir })
      expect((await invalid.load()).length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
